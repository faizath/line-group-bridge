import { validateSignature } from '@line/bot-sdk';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app/context.js';
import type { LineEvent, WebhookBody } from '../line/types.js';

// Events older than this are refused unless LINE marks them as redeliveries (replay defense).
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * POST /webhook: raw body → signature → destination → durable inbox → 200.
 * Nothing else happens here, so LINE's 2 s timeout is never at risk (FR-ING-*, NFR-PERF-1).
 */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Keep the exact bytes: signatures are computed over the raw body, never re-serialized JSON.
  // Registered as an encapsulated plugin so other routes keep normal JSON parsing.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/webhook', async (req, reply) => {
    const started = process.hrtime.bigint();
    const finish = (status: number, payload: unknown = {}) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      ctx.metrics.webhookRequests.inc({ status: String(status) });
      ctx.metrics.webhookLatency.observe(seconds);
      // LINE recommends logging every webhook receipt (FR-OPS-4).
      ctx.log.info({ webhook: { ip: req.ip, path: req.url, status, ms: Math.round(seconds * 1000) } }, 'webhook received');
      return reply.code(status).send(payload);
    };

    const raw = req.body;
    const signature = req.headers['x-line-signature'];
    if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !validateSignature(raw, ctx.config.LINE_CHANNEL_SECRET, signature)) {
      return finish(401, { message: 'invalid signature' });
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as WebhookBody;
    } catch {
      return finish(400, { message: 'invalid JSON' });
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return finish(400, { message: 'invalid body' });

    const botUserId = ctx.bot.userId;
    if (botUserId && body.destination !== botUserId) {
      ctx.log.warn({ destination: body.destination }, 'webhook destination does not match bot user ID');
      return finish(403, { message: 'unexpected destination' });
    }

    const now = ctx.clock.now();
    const rows = body.events.filter((e): e is LineEvent => isStorableEvent(e));
    if (rows.length !== body.events.length) ctx.log.warn({ dropped: body.events.length - rows.length }, 'malformed webhook events skipped');

    try {
      for (const ev of rows) {
        const redelivery = ev.deliveryContext?.isRedelivery === true;
        if (!redelivery && now.getTime() - ev.timestamp > MAX_EVENT_AGE_MS) {
          ctx.metrics.webhookEvents.inc({ outcome: 'stale' });
          ctx.log.warn({ webhookEventId: ev.webhookEventId }, 'stale webhook event refused');
          continue;
        }
        const r = await ctx.db.query(
          `insert into inbound_events (webhook_event_id, channel_id, type, group_id, event_ts, received_at, is_redelivery, payload)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (webhook_event_id) do nothing`,
          [
            ev.webhookEventId,
            ctx.config.channelId,
            ev.type,
            ev.source?.groupId ?? null,
            new Date(ev.timestamp),
            now,
            redelivery,
            JSON.stringify(ev),
          ],
        );
        ctx.metrics.webhookEvents.inc({ outcome: r.rowCount > 0 ? 'stored' : 'duplicate' });
      }
    } catch (err) {
      // Not acknowledged: LINE may redeliver (if enabled) once storage is back.
      ctx.log.error({ err }, 'failed to persist webhook events');
      return finish(500, { message: 'storage unavailable' });
    }
    return finish(200);
  });
}

function isStorableEvent(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const ev = e as Partial<LineEvent>;
  return typeof ev.webhookEventId === 'string' && ev.webhookEventId.length > 0 && typeof ev.type === 'string' && typeof ev.timestamp === 'number';
}
