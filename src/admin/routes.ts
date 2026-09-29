import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app/context.js';
import { attachedGroups, cancelTargetJobs, getBridge, getGroup, nextShortTag } from '../core/groups.js';
import { releaseStrictHolds } from '../core/jobs.js';
import type { BridgeRow, GroupRow, JobRow } from '../core/rows.js';
import type { QuotaGuard } from '../cost/quotaGuard.js';
import { localDay, monthToDate } from '../cost/usage.js';
import { uuid } from '../util/ids.js';
import { adminAuth } from './auth.js';
import { eraseUserData, exportUserData } from './users.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext, quota: QuotaGuard): Promise<void> {
  app.addHook('preHandler', adminAuth(ctx));

  // --- Bridges ---
  app.get('/admin/v1/bridges', async () => {
    const { rows } = await ctx.db.query<BridgeRow>('select * from bridges order by created_at desc');
    return { bridges: rows };
  });

  app.post<{
    Body: {
      name: string;
      deliveryMode?: BridgeRow['delivery_mode'];
      batchWindowMs?: number;
      maxHoldS?: number | null;
      locale?: string;
    };
  }>('/admin/v1/bridges', async (req, reply) => {
    const { name, deliveryMode = ctx.config.DEFAULT_DELIVERY_MODE, batchWindowMs = ctx.config.BATCH_WINDOW_MS, maxHoldS = ctx.config.ECONOMY_MAX_HOLD_S, locale = ctx.config.LOCALE_DEFAULT } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const id = uuid();
    const { rows } = await ctx.db.query<BridgeRow>(
      `insert into bridges (id, channel_id, name, delivery_mode, batch_window_ms, max_hold_s, locale)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [id, ctx.config.channelId, name, deliveryMode, batchWindowMs, maxHoldS, locale],
    );
    return reply.code(201).send({ bridge: rows[0] });
  });

  app.get<{ Params: { id: string } }>('/admin/v1/bridges/:id', async (req, reply) => {
    const bridge = await getBridge(ctx.db, req.params.id);
    if (!bridge) return reply.code(404).send({ error: 'bridge not found' });
    const groups = await attachedGroups(ctx.db, bridge.id);
    const mtd = await monthToDate(ctx.db, bridge.id, localDay(ctx.clock.now(), ctx.config.QUOTA_TZ));
    return { bridge, groups, usageMonthToDate: mtd };
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<BridgeRow, 'name' | 'delivery_mode' | 'batch_window_ms' | 'max_hold_s' | 'locale' | 'monthly_budget' | 'origin_tag_style' | 'notification_disabled' | 'notices_join' | 'notices_leave' | 'notices_unsend' | 'status'>>;
  }>('/admin/v1/bridges/:id', async (req, reply) => {
    const bridge = await getBridge(ctx.db, req.params.id);
    if (!bridge) return reply.code(404).send({ error: 'bridge not found' });

    const b = req.body ?? {};
    const { rows } = await ctx.db.query<BridgeRow>(
      `update bridges set
         name = coalesce($2, name),
         delivery_mode = coalesce($3, delivery_mode),
         batch_window_ms = coalesce($4, batch_window_ms),
         max_hold_s = case when $5::int is not null then $5 else max_hold_s end,
         locale = coalesce($6, locale),
         monthly_budget = case when $7::bigint is not null then $7 else monthly_budget end,
         status = coalesce($8, status)
       where id = $1 returning *`,
      [bridge.id, b.name ?? null, b.delivery_mode ?? null, b.batch_window_ms ?? null, b.max_hold_s ?? null, b.locale ?? null, b.monthly_budget ?? null, b.status ?? null],
    );
    if (rows[0]) await releaseStrictHolds(ctx.db, rows[0], ctx.clock.now());
    return { bridge: rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/admin/v1/bridges/:id', async (req, reply) => {
    const bridge = await getBridge(ctx.db, req.params.id);
    if (!bridge) return reply.code(404).send({ error: 'bridge not found' });

    await ctx.db.tx(async (q) => {
      await q.query(`update member_groups set state = 'detached', bridge_id = null, short_tag = null where bridge_id = $1`, [bridge.id]);
      await q.query('delete from bridges where id = $1', [bridge.id]);
    });
    return { ok: true };
  });

  // --- Group attachment ---
  app.post<{ Params: { id: string; groupId: string } }>('/admin/v1/bridges/:id/groups/:groupId', async (req, reply) => {
    const bridge = await getBridge(ctx.db, req.params.id);
    if (!bridge) return reply.code(404).send({ error: 'bridge not found' });

    const now = ctx.clock.now();
    const tag = await nextShortTag(ctx.db, bridge.id);
    const { rows } = await ctx.db.query<GroupRow>(
      `update member_groups set bridge_id = $2, state = 'attached', short_tag = $3, attached_at = $4 where group_id = $1 returning *`,
      [req.params.groupId, bridge.id, tag, now],
    );
    return { group: rows[0] };
  });

  app.delete<{ Params: { id: string; groupId: string } }>('/admin/v1/bridges/:id/groups/:groupId', async (req) => {
    await ctx.db.tx(async (q) => {
      await q.query(`update member_groups set state = 'detached', bridge_id = null, short_tag = null where group_id = $1 and bridge_id = $2`, [
        req.params.groupId,
        req.params.id,
      ]);
      await cancelTargetJobs(q, req.params.groupId, 'detached via admin API');
    });
    return { ok: true };
  });

  // --- Groups list & leave ---
  app.get<{ Querystring: { state?: string } }>('/admin/v1/groups', async (req) => {
    const state = req.query.state;
    const { rows } = state
      ? await ctx.db.query<GroupRow>('select * from member_groups where state = $1 order by joined_at desc', [state])
      : await ctx.db.query<GroupRow>('select * from member_groups order by joined_at desc');
    return { groups: rows };
  });

  app.post<{ Params: { groupId: string } }>('/admin/v1/groups/:groupId/leave', async (req, reply) => {
    const group = await getGroup(ctx.db, req.params.groupId);
    if (!group) return reply.code(404).send({ error: 'group not found' });

    await ctx.db.tx(async (q) => {
      await q.query(`update member_groups set state = 'bot_removed' where group_id = $1`, [group.group_id]);
      await cancelTargetJobs(q, group.group_id, 'bot leave commanded via admin');
    });
    try {
      await ctx.line.leaveGroup(group.group_id);
    } catch (err) {
      ctx.log.warn({ err, groupId: group.group_id }, 'LINE leaveGroup call failed');
    }
    return { ok: true };
  });

  // --- Usage & Quota ---
  app.get('/admin/v1/usage', async () => {
    const now = ctx.clock.now();
    const day = localDay(now, ctx.config.QUOTA_TZ);
    const mtd = await monthToDate(ctx.db, null, day);
    const q = await quota.status();
    return { month: day.month, usageMonthToDate: mtd, quota: q };
  });

  app.post('/admin/v1/quota/resume', async () => {
    await quota.resume('operator');
    return { ok: true };
  });

  // --- Dead letter inspection & manual retry ---
  app.get<{ Querystring: { group?: string } }>('/admin/v1/jobs', async (req) => {
    const group = req.query.group;
    const { rows } = group
      ? await ctx.db.query<JobRow>("select * from relay_jobs where state = 'dead' and target_group_id = $1 order by ready_at desc limit 100", [group])
      : await ctx.db.query<JobRow>("select * from relay_jobs where state = 'dead' order by ready_at desc limit 100");
    return { deadJobs: rows };
  });

  app.post<{ Params: { id: string } }>('/admin/v1/jobs/:id/retry', async (req, reply) => {
    const { rows } = await ctx.db.query<JobRow>('select * from relay_jobs where id = $1', [req.params.id]);
    const job = rows[0];
    if (!job) return reply.code(404).send({ error: 'job not found' });

    const now = ctx.clock.now();
    // Re-queue with fresh retry key and reset fallback_step
    await ctx.db.query(
      `update relay_jobs set state = 'queued', ready_at = $2, fallback_step = 0, retry_key = null, request_id = null, last_error = null
       where id = $1`,
      [job.id, now],
    );
    return { ok: true, job: { id: job.id, state: 'queued' } };
  });

  // --- GDPR / APPI data subject rights ---
  app.get<{ Params: { userId: string } }>('/admin/v1/users/:userId', async (req) => {
    const data = await exportUserData(ctx, req.params.userId);
    return data;
  });

  app.delete<{ Params: { userId: string } }>('/admin/v1/users/:userId/data', async (req) => {
    const result = await eraseUserData(ctx, req.params.userId);
    return result;
  });
}
