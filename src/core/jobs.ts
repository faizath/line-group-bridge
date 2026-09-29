import type { Queryable } from '../db/db.js';
import { addMs } from '../util/clock.js';
import { uuid } from '../util/ids.js';
import type { BridgeRow, JobKind, JobState, NoticePayload } from './rows.js';

/** "Never" for strict economy: held jobs only leave through reply-token flushes. */
export const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

/** State and earliest push time for a newly enqueued job, per delivery mode (FR-COST-1). */
export function jobTiming(bridge: Pick<BridgeRow, 'delivery_mode' | 'batch_window_ms' | 'max_hold_s'>, now: Date): { state: JobState; readyAt: Date } {
  switch (bridge.delivery_mode) {
    case 'immediate':
      return { state: 'queued', readyAt: now };
    case 'batched':
      return { state: 'queued', readyAt: addMs(now, bridge.batch_window_ms) };
    case 'economy':
      return bridge.max_hold_s === null
        ? { state: 'held', readyAt: FAR_FUTURE }
        : { state: 'held', readyAt: addMs(now, bridge.max_hold_s * 1000) };
    case 'strict_economy':
      return { state: 'held', readyAt: FAR_FUTURE };
  }
}

export interface NewJob {
  bridgeId: string;
  originMessageId: string | null;
  originGroupId: string | null;
  targetGroupId: string;
  kind: JobKind;
  state: JobState;
  orderTs: Date;
  orderIdx?: number;
  readyAt: Date;
  notice?: NoticePayload;
  seq?: number;
}

/** Idempotent via unique (origin_message_id, target_group_id, kind, seq): reprocessing an event creates nothing new. */
export async function insertJobs(q: Queryable, jobs: NewJob[]): Promise<number> {
  let inserted = 0;
  for (const j of jobs) {
    const r = await q.query(
      `insert into relay_jobs (id, bridge_id, origin_message_id, origin_group_id, target_group_id, kind, state, order_ts, order_idx, ready_at, notice, seq)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (origin_message_id, target_group_id, kind, seq) do nothing`,
      [
        uuid(),
        j.bridgeId,
        j.originMessageId,
        j.originGroupId,
        j.targetGroupId,
        j.kind,
        j.state,
        j.orderTs,
        j.orderIdx ?? 0,
        j.readyAt,
        j.notice ? JSON.stringify(j.notice) : null,
        j.seq ?? 0,
      ],
    );
    inserted += r.rowCount;
  }
  return inserted;
}

/** Queues a bot-authored notice into each target through the normal lanes (economy rules apply). */
export async function enqueueNotice(
  q: Queryable,
  bridge: BridgeRow,
  targetGroupIds: string[],
  notice: NoticePayload,
  now: Date,
): Promise<void> {
  const timing = jobTiming(bridge, now);
  await insertJobs(
    q,
    targetGroupIds.map((targetGroupId) => ({
      bridgeId: bridge.id,
      originMessageId: null,
      originGroupId: null,
      targetGroupId,
      kind: 'notice' as const,
      state: timing.state,
      orderTs: now,
      readyAt: timing.readyAt,
      notice,
    })),
  );
}

/**
 * Mode changes apply to newly enqueued messages (US-5), but jobs parked "forever" by strict economy
 * must get a real deadline once the bridge leaves strict mode, or they would never be pushed.
 */
export async function releaseStrictHolds(q: Queryable, bridge: BridgeRow, now: Date): Promise<void> {
  const timing = jobTiming(bridge, now);
  if (timing.readyAt.getTime() === FAR_FUTURE.getTime()) return;
  await q.query(
    `update relay_jobs set state = $2, ready_at = $3
     where bridge_id = $1 and state in ('queued','held') and ready_at >= $4`,
    [bridge.id, timing.state, timing.readyAt, FAR_FUTURE],
  );
}
