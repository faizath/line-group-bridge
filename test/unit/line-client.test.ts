import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { LineApiError } from '../../src/line/adapter.js';
import { SdkLineClient, type ApiCallEvent } from '../../src/line/client.js';
import { NoopRateLimiter, type RateBucket } from '../../src/line/rateLimiter.js';
import type { TokenProvider } from '../../src/line/tokens.js';
import { createLogger } from '../../src/logger.js';

let app: FastifyInstance;
let base: string;
let pushes: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

beforeAll(async () => {
  app = Fastify({ forceCloseConnections: true });
  app.post('/v2/bot/message/push', async (req, reply) => {
    const body = req.body as { to: string };
    pushes.push({ headers: req.headers, body: body as Record<string, unknown> });
    reply.header('x-line-request-id', `req-${pushes.length}`);
    switch (body.to) {
      case 'Gdup':
        return reply
          .code(409)
          .header('x-line-accepted-request-id', 'req-original')
          .send({ message: 'The retry key is already accepted', sentMessages: [{ id: '111', quoteToken: 'q1' }] });
      case 'Gquota':
        return reply.code(429).send({ message: 'You have reached your monthly limit.' });
      case 'Grate':
        return reply.code(429).send({ message: 'Too Many Requests' });
      case 'G5xx':
        return reply.code(503).send({ message: 'Service unavailable' });
      case 'Gbad':
        return reply.code(400).send({ message: 'The request body has 1 error(s)', details: [{ message: 'bad', property: 'messages[0].text' }] });
      case 'Gauth':
        return reply.code(401).send({ message: 'Authentication failed' });
      case 'Gslow':
        await delay(1_000);
        return { sentMessages: [] };
      default:
        return { sentMessages: [{ id: '100', quoteToken: 'q0' }] };
    }
  });
  app.get('/v2/bot/group/:groupId/member/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (userId === 'Ugone') return reply.code(404).send({ message: 'Not found' });
    return { userId, displayName: 'Alice', pictureUrl: 'https://profile.example/a' };
  });
  app.get('/v2/bot/message/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    switch (id) {
      case 'preparing':
        return reply.code(202).send();
      case 'gone':
        return reply.code(410).send({ message: 'Gone' });
      case 'big-declared':
        return reply.type('video/mp4').send(Buffer.alloc(4096));
      case 'big-streamed':
        // Chunked: no content-length, so the limit must be enforced while reading.
        return reply.type('video/mp4').send(Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(1024))));
      default:
        return reply.type('image/png').send(PNG);
    }
  });
  app.get('/v2/bot/message/:id/content/preview', async (_req, reply) => reply.code(404).send({ message: 'Not found' }));
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  pushes = [];
});

function setup(opts: { timeoutMs?: number; tokens?: string[]; apiBase?: string } = {}) {
  const config = loadConfig({
    LINE_CHANNEL_SECRET: 'secret',
    LINE_ACCESS_TOKEN: 'tok',
    DATABASE_URL: 'pglite://memory',
    MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
    MEDIA_BACKEND: 'fs',
    LINE_API_BASE: opts.apiBase ?? base,
    LINE_API_DATA_BASE: base,
  });
  const tokenSeq = [...(opts.tokens ?? ['tok'])];
  const state = { invalidations: 0, buckets: [] as RateBucket[], calls: [] as ApiCallEvent[] };
  const tokens: TokenProvider = {
    getToken: async () => (tokenSeq.length > 1 ? tokenSeq.shift()! : tokenSeq[0]!),
    invalidate: () => {
      state.invalidations++;
    },
    status: () => ({ mode: 'long_lived', expiresAt: null }),
  };
  const limiter = new (class extends NoopRateLimiter {
    override async acquire(bucket: RateBucket): Promise<void> {
      state.buckets.push(bucket);
    }
  })();
  const client = new SdkLineClient({
    config,
    tokens,
    limiter,
    log: createLogger('silent'),
    timeoutMs: opts.timeoutMs,
    onApiCall: (e) => state.calls.push(e),
  });
  return { client, state };
}

async function pushError(client: SdkLineClient, to: string): Promise<LineApiError> {
  const err = await client.push(to, [{ type: 'text', text: 'hi' }], { retryKey: 'k' }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LineApiError);
  return err as LineApiError;
}

describe('SdkLineClient.push', () => {
  it('sends the retry key and returns sentMessages with the request id', async () => {
    const { client, state } = setup();
    const res = await client.push('Gok', [{ type: 'text', text: 'hi' }], {
      retryKey: '123e4567-e89b-12d3-a456-426614174000',
      notificationDisabled: true,
    });
    expect(res).toEqual({ status: 200, sentMessages: [{ id: '100', quoteToken: 'q0' }], requestId: 'req-1' });
    expect(pushes[0]!.headers['x-line-retry-key']).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(pushes[0]!.headers.authorization).toBe('Bearer tok');
    expect(pushes[0]!.body.notificationDisabled).toBe(true);
    expect(state.buckets).toEqual(['api']);
    expect(state.calls).toEqual([
      { endpoint: '/v2/bot/message/push', method: 'POST', status: 200, ms: expect.any(Number), requestId: 'req-1' },
    ]);
  });

  it('treats 409 as success carrying the originally sent messages', async () => {
    const { client, state } = setup();
    const res = await client.push('Gdup', [{ type: 'text', text: 'hi' }], { retryKey: 'k' });
    expect(res).toEqual({
      status: 409,
      sentMessages: [{ id: '111', quoteToken: 'q1' }],
      acceptedRequestId: 'req-original',
      requestId: 'req-1',
    });
    expect(state.calls[0]!.status).toBe(409);
  });

  it('flags the monthly-limit 429 as non-retryable and the rate-limit 429 as retryable', async () => {
    const { client } = setup();
    const quota = await pushError(client, 'Gquota');
    expect(quota.status).toBe(429);
    expect(quota.isMonthlyLimit).toBe(true);
    expect(quota.isRetryable).toBe(false);
    const rate = await pushError(client, 'Grate');
    expect(rate.isMonthlyLimit).toBe(false);
    expect(rate.isRetryable).toBe(true);
  });

  it('maps 5xx to a retryable error and 400 to a non-retryable one with details', async () => {
    const { client, state } = setup();
    const e5 = await pushError(client, 'G5xx');
    expect(e5).toMatchObject({ status: 503, message: 'Service unavailable', endpoint: '/v2/bot/message/push', requestId: 'req-1' });
    expect(e5.isRetryable).toBe(true);
    const e4 = await pushError(client, 'Gbad');
    expect(e4.isRetryable).toBe(false);
    expect(e4.details).toEqual([{ message: 'bad', property: 'messages[0].text' }]);
    expect(state.calls.map((c) => c.status)).toEqual([503, 400]);
  });

  it('times out as a retryable status-0 error', async () => {
    const { client, state } = setup({ timeoutMs: 100 });
    const err = await pushError(client, 'Gslow');
    expect(err.status).toBe(0);
    expect(err.isRetryable).toBe(true);
    expect(state.calls[0]!.status).toBe(0);
  });

  it('invalidates the token on 401 and switches to a new token string', async () => {
    const { client, state } = setup({ tokens: ['old', 'new'] });
    const err = await pushError(client, 'Gauth');
    expect(err.status).toBe(401);
    expect(state.invalidations).toBe(1);
    await client.push('Gok', [{ type: 'text', text: 'hi' }], { retryKey: 'k2' });
    expect(pushes.map((p) => p.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('reports network failures as status 0', async () => {
    // Port 1 is never listening, so the connection is refused.
    const { client } = setup({ apiBase: 'http://127.0.0.1:1' });
    const err = await pushError(client, 'Gok');
    expect(err.status).toBe(0);
  });
});

describe('SdkLineClient reads', () => {
  it('returns null for a 404 member profile', async () => {
    const { client } = setup();
    expect(await client.getGroupMemberProfile('G1', 'Ugone')).toBeNull();
    expect(await client.getGroupMemberProfile('G1', 'Ualice')).toEqual({
      userId: 'Ualice',
      displayName: 'Alice',
      pictureUrl: 'https://profile.example/a',
    });
  });

  it('downloads content through the data bucket', async () => {
    const { client, state } = setup();
    expect(await client.getContent('m1', 1024)).toEqual({ status: 'ready', contentType: 'image/png', data: PNG });
    expect(state.buckets).toEqual(['data']);
  });

  it('reports 202 as preparing', async () => {
    const { client } = setup();
    expect(await client.getContent('preparing', 1024)).toEqual({ status: 'preparing' });
  });

  it('aborts oversized content with 413, whether declared or streamed', async () => {
    const { client } = setup();
    for (const id of ['big-declared', 'big-streamed']) {
      const err = await client.getContent(id, 2048).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LineApiError);
      expect((err as LineApiError).status).toBe(413);
    }
    const exact = await client.getContent('big-declared', 4096);
    expect(exact.status === 'ready' && exact.data.length).toBe(4096);
  });

  it('surfaces 410 for expired content and null for a missing preview', async () => {
    const { client } = setup();
    const err = await client.getContent('gone', 1024).catch((e: unknown) => e);
    expect((err as LineApiError).status).toBe(410);
    expect(await client.getContentPreview('m1')).toBeNull();
  });
});
