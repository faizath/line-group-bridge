import type { AppContext } from '../app/context.js';
import { getBridge, getGroup } from '../core/groups.js';
import { FAR_FUTURE, insertJobs, jobTiming } from '../core/jobs.js';
import { claimFreshToken, REPLY_TOKEN_MAX_AGE_MS } from '../core/replyTokens.js';
import type { BridgeRow, JobRow } from '../core/rows.js';
import type { QuotaGuard } from '../cost/quotaGuard.js';
import { localDay, recordUsage } from '../cost/usage.js';
import type { Queryable } from '../db/db.js';
import { translator } from '../i18n/index.js';
import type { SendResult } from '../line/adapter.js';
import { LineApiError } from '../line/adapter.js';
import type { OutboundMessage } from '../line/types.js';
import { alert } from '../logger.js';
import { pack } from '../translate/pack.js';
import { senderName } from '../translate/translate.js';
import type { PackedPart } from '../translate/types.js';
import { addMs } from '../util/clock.js';
import { uuid } from '../util/ids.js';
import { bridgeIconUrl, renderJobs } from './render.js';
import {
  MAX_FALLBACK_STEP,
  MAX_PUSH_ATTEMPTS,
  MAX_RETRY_WINDOW_MS,
  RETRY_KEY_MAX_AGE_MS,
  backoffMs,
  classify,
  isReplyTokenError,
} from './retry.js';

const LEASE_MS = 60_000;
/** Jobs considered per lane pass; enough for several 5-object requests. */
const LANE_SCAN_LIMIT = 50;
/** When pushes are blocked by the quota guard, re-check after this long. */
const PUSH_BLOCKED_RECHECK_MS = 5 * 60_000;
/** Requests sent per lane activation before yielding to other lanes. */
const MAX_REQUESTS_PER_ACTIVATION = 10;

interface RequestRow {
  id: string;
  target_group_id: string;
  bridge_id: string | null;
  method: 'push' | 'reply';
  retry_key: string | null;
  reply_token: string | null;
  body: { messages: OutboundMessage[]; notificationDisabled: boolean };
  parts: PackedPart[];
  state: 'pending' | 'sending' | 'done' | 'failed' | 'dead';
  attempts: number;
  first_attempt_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  billed_estimate: number;
}

export type LaneOutcome = 'sent' | 'idle' | 'busy';

/**
 * One serial lane per target group (FR-RLY-4, NFR-REL-5): at most one in-flight request per
 * target, requests carry ≤ 5 objects, pushes carry a persisted retry key, reply tokens are
 * used whenever one is available because replies are free (FR-COST-3).
 */
export class Lanes {
  constructor(
    private ctx: AppContext,
    private quota: QuotaGuard,
  ) {}

  /** Target groups with work due now: ready jobs, retries due, crashed sends, or a fresh reply token plus a backlog. */
  async dueLanes(limit = 100): Promise<string[]> {
    const now = this.ctx.clock.now();
    const { rows } = await this.ctx.db.query<{ g: string }>(
      `select g from (
         select target_group_id as g from relay_jobs where state in ('queued','held') and ready_at <= $1
         union
         select target_group_id from outbound_requests
           where (state = 'pending' and next_attempt_at <= $1) or (state = 'sending' and lease_until < $1)
         union
         select rt.group_id from reply_tokens rt
           where rt.claimed_at is null and rt.issued_at > $2
             and exists (select 1 from relay_jobs j where j.target_group_id = rt.group_id and j.state in ('queued','held'))
       ) due
       where not exists (select 1 from lanes l where l.group_id = due.g and l.lease_until >= $1)
       limit $3`,
      [now, new Date(now.getTime() - REPLY_TOKEN_MAX_AGE_MS), limit],
    );
    return rows.map((r) => r.g);
  }

  /** Processes due lanes with bounded parallelism. Returns the number of lanes that sent something. */
  async runDue(concurrency: number): Promise<number> {
    const lanes = await this.dueLanes();
    let sent = 0;
    for (let i = 0; i < lanes.length; i += concurrency) {
      const results = await Promise.all(lanes.slice(i, i + concurrency).map((g) => this.processLane(g)));
      sent += results.filter((r) => r === 'sent').length;
    }
    return sent;
  }

  async processLane(groupId: string): Promise<LaneOutcome> {
    if (!(await this.acquire(groupId))) return 'busy';
    let outcome: LaneOutcome = 'idle';
    try {
      for (let i = 0; i < MAX_REQUESTS_PER_ACTIVATION; i++) {
        if (!(await this.step(groupId))) break;
        outcome = 'sent';
      }
    } catch (err) {
      this.ctx.log.error({ err, groupId }, 'lane processing failed');
    } finally {
      await this.release(groupId);
    }
    return outcome;
  }

  private async acquire(groupId: string): Promise<boolean> {
    const now = this.ctx.clock.now();
    const { rowCount } = await this.ctx.db.query(
      `insert into lanes (group_id, lease_owner, lease_until) values ($1, $2, $3)
       on conflict (group_id) do update set lease_owner = excluded.lease_owner, lease_until = excluded.lease_until
       where lanes.lease_until is null or lanes.lease_until < $4`,
      [groupId, this.ctx.instanceId, addMs(now, LEASE_MS), now],
    );
    return rowCount > 0;
  }

  private async release(groupId: string): Promise<void> {
    await this.ctx.db.query(`update lanes set lease_until = null where group_id = $1 and lease_owner = $2`, [groupId, this.ctx.instanceId]);
  }

  /** Releases every lane lease held by this process (graceful shutdown, NFR-REL-6). */
  async releaseAll(): Promise<void> {
    await this.ctx.db.query(`update lanes set lease_until = null where lease_owner = $1`, [this.ctx.instanceId]);
  }

  /** Sends at most one request. Returns true when something was sent or settled. */
  private async step(groupId: string): Promise<boolean> {
    const { ctx } = this;
    const now = ctx.clock.now();

    const open = await ctx.db.query<RequestRow>(
      `select * from outbound_requests where target_group_id = $1 and state in ('pending','sending') order by created_at limit 1`,
      [groupId],
    );
    const req = open.rows[0];
    if (req) {
      if (req.state === 'sending') {
        if (req.lease_until && req.lease_until >= now) return false;
        // Only reachable after a crash mid-send (we hold the lane lease).
        if (req.method === 'reply') {
          await this.settleAmbiguousReply(req);
          return true;
        }
      } else if (req.next_attempt_at > now) {
        return false;
      }
      await this.send(req);
      return true;
    }

    const target = await getGroup(ctx.db, groupId);
    if (!target || target.state !== 'attached' || !target.bridge_id) {
      await ctx.db.query(
        `update relay_jobs set state = 'cancelled', last_error = 'target not attached' where target_group_id = $1 and state in ('waiting','queued','held')`,
        [groupId],
      );
      return false;
    }
    const bridge = await getBridge(ctx.db, target.bridge_id);
    if (!bridge || bridge.status !== 'active' || !target.relay_in) return false;

    const { rows: jobs } = await ctx.db.query<JobRow>(
      `select * from relay_jobs where target_group_id = $1 and state in ('waiting','queued','held')
       order by order_ts, order_idx, created_at limit $2`,
      [groupId, LANE_SCAN_LIMIT],
    );
    const { replyable, pushable } = selectDeliverable(jobs, now);
    if (replyable.length === 0) return false;

    const token = await claimFreshToken(ctx.db, groupId, 'outbox', now);
    let method: 'push' | 'reply';
    let selected: JobRow[];
    if (token) {
      method = 'reply';
      selected = replyable;
    } else {
      if (pushable.length === 0) return false;
      const allowed = bridge.delivery_mode !== 'strict_economy' && (await this.quota.canPush(bridge));
      if (!allowed) {
        const fresh = await getBridge(ctx.db, bridge.id);
        const holdUntil = fresh?.delivery_mode === 'strict_economy' ? FAR_FUTURE : addMs(now, PUSH_BLOCKED_RECHECK_MS);
        await ctx.db.query(`update relay_jobs set state = 'held', ready_at = $2 where id = any($1::uuid[])`, [pushable.map((j) => j.id), holdUntil]);
        return false;
      }
      method = 'push';
      selected = pushable;
    }

    const rendered = await renderJobs(ctx, bridge, target, selected);
    for (const d of rendered.dropped) {
      await ctx.db.query(`update relay_jobs set state = 'cancelled', last_error = $2 where id = $1`, [d.jobId, d.reason]);
    }
    if (rendered.items.length === 0) {
      if (token) ctx.metrics.replyFlush.inc({ outcome: 'miss' });
      return rendered.dropped.length > 0;
    }

    const t = translator(bridge.locale);
    const packMode =
      bridge.delivery_mode === 'economy' || bridge.delivery_mode === 'strict_economy'
        ? 'digest'
        : method === 'push' && bridge.delivery_mode === 'immediate'
          ? 'preserve'
          : 'merge';
    const packed = pack(rendered.items, {
      mode: packMode,
      digestSender: { name: senderName(bridge.name, '', 'none', ctx.config.FORBIDDEN_NAME_WORDS, t), iconUrl: await bridgeIconUrl(ctx, bridge) },
      t,
    });
    if (packed.messages.length === 0) return false;

    const request: RequestRow = {
      id: uuid(),
      target_group_id: groupId,
      bridge_id: bridge.id,
      method,
      retry_key: method === 'push' ? uuid() : null,
      reply_token: token,
      body: { messages: packed.messages, notificationDisabled: bridge.notification_disabled },
      parts: packed.parts,
      state: 'pending',
      attempts: 0,
      first_attempt_at: null,
      next_attempt_at: now,
      lease_until: null,
      billed_estimate: method === 'push' ? (target.member_count ?? 0) : 0,
    };
    await ctx.db.tx(async (q) => {
      // The retry key is persisted with the body before the first attempt (FR-RLY-2).
      await q.query(
        `insert into outbound_requests (id, target_group_id, bridge_id, method, retry_key, reply_token, body, parts, state, next_attempt_at, billed_estimate)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
        [
          request.id,
          groupId,
          bridge.id,
          method,
          request.retry_key,
          token,
          JSON.stringify(request.body),
          JSON.stringify(request.parts),
          now,
          request.billed_estimate,
        ],
      );
      await q.query(`update relay_jobs set state = 'sending', request_id = $2, retry_key = $3 where id = any($1::uuid[])`, [
        packed.includedJobIds,
        request.id,
        request.retry_key,
      ]);
      if (packed.summarizedJobIds.length > 0) {
        await q.query(
          `update relay_jobs set state = 'delivered', delivered_via = 'summary', delivered_at = $2, request_id = $3 where id = any($1::uuid[])`,
          [packed.summarizedJobIds, now, request.id],
        );
      }
    });
    await this.send(request);
    return true;
  }

  private async send(req: RequestRow): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    if (req.method === 'push' && req.first_attempt_at && now.getTime() - req.first_attempt_at.getTime() > RETRY_KEY_MAX_AGE_MS) {
      await this.deadLetter(req, 'retry key window exceeded');
      return;
    }
    await ctx.db.query(
      `update outbound_requests set state = 'sending', attempts = attempts + 1, first_attempt_at = coalesce(first_attempt_at, $2), lease_until = $3
       where id = $1`,
      [req.id, now, addMs(now, LEASE_MS)],
    );
    await ctx.db.query(`update relay_jobs set attempts = attempts + 1 where request_id = $1 and state = 'sending'`, [req.id]);
    req.attempts += 1;
    req.first_attempt_at ??= now;
    const jobIds = await this.requestJobIds(req.id);
    const attempt = await ctx.db.query<{ id: number }>(
      `insert into relay_attempts (request_id, job_ids, target_group_id, method, retry_key, started_at)
       values ($1, $2::uuid[], $3, $4, $5, $6) returning id`,
      [req.id, jobIds, req.target_group_id, req.method, req.retry_key, now],
    );
    const attemptId = attempt.rows[0]!.id;

    let result: SendResult;
    try {
      result =
        req.method === 'push'
          ? await ctx.line.push(req.target_group_id, req.body.messages, {
              retryKey: req.retry_key!,
              notificationDisabled: req.body.notificationDisabled,
            })
          : await ctx.line.reply(req.reply_token!, req.body.messages, { notificationDisabled: req.body.notificationDisabled });
    } catch (err) {
      await this.onFailure(req, err, attemptId);
      return;
    }
    await this.onSuccess(req, result, attemptId);
  }

  private async requestJobIds(requestId: string): Promise<string[]> {
    const { rows } = await this.ctx.db.query<{ id: string }>(`select id from relay_jobs where request_id = $1`, [requestId]);
    return rows.map((r) => r.id);
  }

  private async onSuccess(req: RequestRow, result: SendResult, attemptId: number): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const delivered = await ctx.db.tx(async (q) => {
      await q.query(`update outbound_requests set state = 'done', finished_at = $2, lease_until = null where id = $1`, [req.id, now]);
      await q.query(
        `update relay_attempts set http_status = $2, request_id_line = $3, accepted_request_id = $4, billed_estimate = $5, finished_at = $6 where id = $1`,
        [attemptId, result.status, result.requestId ?? null, result.acceptedRequestId ?? null, req.billed_estimate, now],
      );
      await recordCopies(q, req, result);
      const { rows } = await q.query<{ id: string; kind: string; origin_message_id: string | null; order_ts: Date }>(
        `update relay_jobs set state = 'delivered', delivered_via = $2, delivered_at = $3, last_error = null
         where request_id = $1 and state = 'sending' returning id, kind, origin_message_id, order_ts`,
        [req.id, req.method, now],
      );
      if (req.bridge_id) {
        const day = localDay(now, ctx.config.QUOTA_TZ).day;
        const relayed = rows.filter((r) => r.kind === 'relay').length;
        await recordUsage(
          q,
          req.bridge_id,
          day,
          req.method === 'push' ? { pushes: 1, billed: req.billed_estimate, relayed } : { replies: 1, relayed },
        );
      }
      return rows;
    });

    ctx.metrics.relayRequests.inc({ method: req.method, outcome: result.status === 409 ? 'duplicate_accepted' : 'ok' });
    if (req.method === 'reply') ctx.metrics.replyFlush.inc({ outcome: 'hit' });
    if (req.bridge_id && req.billed_estimate > 0) ctx.metrics.billedEstimate.inc({ bridge: req.bridge_id }, req.billed_estimate);
    ctx.log.info(
      {
        requestId: req.id,
        target: req.target_group_id,
        method: req.method,
        status: result.status,
        lineRequestId: result.requestId,
        acceptedRequestId: result.acceptedRequestId,
        jobs: delivered.map((d) => d.id),
      },
      'relay delivered',
    );
    await this.afterDelivery(req, delivered, now);
  }

  /** Latency metrics, and unsend notices for copies that were already in flight when the author unsent. */
  private async afterDelivery(req: RequestRow, delivered: { id: string; kind: string; origin_message_id: string | null }[], now: Date) {
    const { ctx } = this;
    const originIds = delivered.filter((d) => d.kind === 'relay' && d.origin_message_id).map((d) => d.origin_message_id!);
    if (originIds.length === 0 || !req.bridge_id) return;
    const bridge = await getBridge(ctx.db, req.bridge_id);
    const { rows } = await ctx.db.query<{ message_id: string; type: string; event_ts: Date; unsent_at: Date | null; user_id: string | null }>(
      `select message_id, type, event_ts, unsent_at, user_id from origin_messages where message_id = any($1::text[])`,
      [originIds],
    );
    for (const o of rows) {
      ctx.metrics.relayLatency.observe(
        { type: o.type, mode: bridge?.delivery_mode ?? 'unknown', method: req.method },
        Math.max(0, (now.getTime() - o.event_ts.getTime()) / 1000),
      );
      if (o.unsent_at && bridge?.notices_unsend) {
        const name = o.user_id
          ? ((await ctx.db.query<{ display_name: string | null }>('select display_name from line_users where user_id = $1', [o.user_id])).rows[0]
              ?.display_name ?? null)
          : null;
        await enqueueUnsendNotice(ctx.db, bridge, o.message_id, req.target_group_id, name ?? translator(bridge.locale)('line_user'), now);
      }
    }
  }

  private async onFailure(req: RequestRow, err: unknown, attemptId: number): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const status = err instanceof LineApiError ? err.status : 0;
    await ctx.db.query(
      `update relay_attempts set http_status = $2, request_id_line = $3, error_message = $4, finished_at = $5 where id = $1`,
      [attemptId, status, err instanceof LineApiError ? (err.requestId ?? null) : null, errorText(err), now],
    );
    ctx.metrics.relayRequests.inc({ method: req.method, outcome: `error_${status}` });
    const failure = classify(err);

    if (req.method === 'reply') {
      if (status === 0) {
        // A timed-out reply may have been accepted and cannot be retried idempotently (ADR-007).
        await this.settleAmbiguousReply(req);
        return;
      }
      ctx.metrics.replyFlush.inc({ outcome: 'failed' });
      const contentError = failure.kind === 'bad_request' && !isReplyTokenError(err);
      if (contentError) await this.denyRejectedStickers(req, err);
      await this.returnJobs(req, { fallbackIncrement: contentError ? 1 : 0, error: errorText(err) });
      return;
    }

    switch (failure.kind) {
      case 'retry': {
        const elapsed = now.getTime() - (req.first_attempt_at ?? now).getTime();
        if (req.attempts >= MAX_PUSH_ATTEMPTS || elapsed >= MAX_RETRY_WINDOW_MS) {
          await this.deadLetter(req, `retries exhausted: ${errorText(err)}`);
          return;
        }
        if (failure.reason === 'unauthorized') alert(ctx.log, 'line_unauthorized', { status });
        ctx.metrics.retries.inc({ reason: failure.reason });
        await ctx.db.query(
          `update outbound_requests set state = 'pending', next_attempt_at = $2, lease_until = null, last_error = $3 where id = $1`,
          [req.id, addMs(now, backoffMs(req.attempts)), errorText(err)],
        );
        return;
      }
      case 'monthly_limit':
        // Nothing was sent (LINE requests are atomic); the jobs wait for free replies.
        await this.quota.onMonthlyLimit();
        await this.returnJobs(req, { fallbackIncrement: 0, error: errorText(err), holdUntil: FAR_FUTURE });
        return;
      case 'bad_request':
        await this.denyRejectedStickers(req, err);
        // Rebuilt at the next fallback step with a new retry key, since the body changes (FR-RLY-3).
        ctx.metrics.retries.inc({ reason: 'fallback' });
        await this.returnJobs(req, { fallbackIncrement: 1, error: errorText(err) });
        return;
      case 'fatal':
        await this.deadLetter(req, errorText(err));
        return;
    }
  }

  /** Puts a failed request's jobs back into the lane (not accepted by LINE). */
  private async returnJobs(req: RequestRow, opts: { fallbackIncrement: number; error: string; holdUntil?: Date }): Promise<void> {
    const { ctx } = this;
    await ctx.db.tx(async (q) => {
      await q.query(`update outbound_requests set state = 'failed', finished_at = $2, lease_until = null, last_error = $3 where id = $1`, [
        req.id,
        ctx.clock.now(),
        opts.error,
      ]);
      const { rows: dead } = await q.query<{ id: string }>(
        `update relay_jobs set state = 'dead', last_error = $3, request_id = null
         where request_id = $1 and state = 'sending' and fallback_step + $2 > $4 returning id`,
        [req.id, opts.fallbackIncrement, opts.error, MAX_FALLBACK_STEP],
      );
      if (dead.length > 0) {
        ctx.metrics.deadLetters.inc(dead.length);
        alert(ctx.log, 'dead_letter', { requestId: req.id, jobs: dead.map((d) => d.id), error: opts.error });
      }
      await q.query(
        `update relay_jobs j set
           state = case when b.delivery_mode in ('economy','strict_economy') then 'held' else 'queued' end,
           ready_at = coalesce($3, j.ready_at),
           fallback_step = j.fallback_step + $2, request_id = null, last_error = $4
         from bridges b
         where j.request_id = $1 and j.state = 'sending' and b.id = j.bridge_id`,
        [req.id, opts.fallbackIncrement, opts.holdUntil ?? null, opts.error],
      );
    });
  }

  private async deadLetter(req: RequestRow, error: string): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const jobs = await ctx.db.tx(async (q) => {
      await q.query(`update outbound_requests set state = 'dead', finished_at = $2, lease_until = null, last_error = $3 where id = $1`, [
        req.id,
        now,
        error,
      ]);
      const { rows } = await q.query<{ id: string }>(
        `update relay_jobs set state = 'dead', last_error = $2 where request_id = $1 and state = 'sending' returning id`,
        [req.id, error],
      );
      return rows;
    });
    ctx.metrics.deadLetters.inc(jobs.length);
    alert(ctx.log, 'dead_letter', { requestId: req.id, target: req.target_group_id, jobs: jobs.map((j) => j.id), error });
  }

  /** Reply outcome unknown after a crash or timeout: treated as delivered to avoid duplicates (ADR-007). */
  private async settleAmbiguousReply(req: RequestRow): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    ctx.log.warn({ requestId: req.id, target: req.target_group_id, event: 'ambiguous_reply' }, 'ambiguous_reply: treating reply as delivered');
    await ctx.db.tx(async (q) => {
      await q.query(`update outbound_requests set state = 'done', finished_at = $2, lease_until = null, last_error = 'ambiguous_reply' where id = $1`, [
        req.id,
        now,
      ]);
      await q.query(
        `update relay_jobs set state = 'delivered', delivered_via = 'reply', delivered_at = $2, last_error = 'ambiguous_reply'
         where request_id = $1 and state = 'sending'`,
        [req.id, now],
      );
    });
  }

  /** A 400 that points at a sticker object adds that sticker to the runtime deny-cache ([09] §5). */
  private async denyRejectedStickers(req: RequestRow, err: unknown): Promise<void> {
    if (!(err instanceof LineApiError)) return;
    const indexes = new Set<number>();
    for (const d of err.details) {
      const m = /messages\[(\d+)\]/.exec(d.property ?? '');
      if (m) indexes.add(Number(m[1]));
    }
    const stickers = req.body.messages.filter((m, i) => m.type === 'sticker' && (indexes.size === 0 || indexes.has(i)));
    for (const s of stickers) {
      if (s.type !== 'sticker') continue;
      this.ctx.stickers.deny(s.packageId, s.stickerId);
      await this.ctx.db.query(`insert into sticker_denylist (package_id, sticker_id) values ($1, $2) on conflict do nothing`, [
        s.packageId,
        s.stickerId,
      ]);
    }
  }
}

/**
 * Splits a lane's backlog into what a reply could carry now and what a push may carry now.
 * A job waiting for media (or not yet due) blocks later jobs from the same origin group,
 * preserving per-(origin, target) order without stalling other origins (FR-RLY-4).
 */
export function selectDeliverable(jobs: JobRow[], now: Date): { replyable: JobRow[]; pushable: JobRow[] } {
  const replyBlocked = new Set<string>();
  const pushBlocked = new Set<string>();
  const replyable: JobRow[] = [];
  const pushable: JobRow[] = [];
  for (const j of jobs) {
    const key = j.origin_group_id ?? '(notices)';
    if (j.state === 'waiting') {
      replyBlocked.add(key);
      pushBlocked.add(key);
      continue;
    }
    if (!replyBlocked.has(key)) replyable.push(j);
    if (pushBlocked.has(key)) continue;
    if (j.ready_at <= now) pushable.push(j);
    else pushBlocked.add(key);
  }
  return { replyable, pushable };
}

async function recordCopies(q: Queryable, req: RequestRow, result: SendResult): Promise<void> {
  for (const [i, part] of req.parts.entries()) {
    const sent = result.sentMessages[i];
    if (!sent) continue;
    for (const originId of part.originMessageIds) {
      await q.query(
        `insert into relay_copies (target_group_id, sent_message_id, origin_message_id, part_index, quote_token)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [req.target_group_id, sent.id, originId, part.partIndex, sent.quoteToken ?? null],
      );
    }
  }
}

export async function enqueueUnsendNotice(
  q: Queryable,
  bridge: BridgeRow,
  originMessageId: string,
  targetGroupId: string,
  author: string,
  now: Date,
): Promise<void> {
  const timing = jobTiming(bridge, now);
  await insertJobs(q, [
    {
      bridgeId: bridge.id,
      originMessageId,
      originGroupId: null,
      targetGroupId,
      kind: 'unsend_notice',
      state: timing.state,
      orderTs: now,
      readyAt: timing.readyAt,
      notice: { key: 'unsent_by', vars: { author } },
    },
  ]);
}

function errorText(err: unknown): string {
  if (err instanceof LineApiError) {
    const details = err.details.map((d) => `${d.property ?? ''}: ${d.message ?? ''}`).join('; ');
    return `${err.status} ${err.message}${details ? ` (${details})` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}
