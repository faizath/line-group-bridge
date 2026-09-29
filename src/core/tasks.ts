import type { Db, Queryable } from '../db/db.js';
import { addMs } from '../util/clock.js';
import { uuid } from '../util/ids.js';

export type TaskKind = 'media_fetch' | 'imageset_flush' | 'group_meta' | 'group_count';

export interface TaskRow {
  id: string;
  kind: TaskKind;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  run_at: Date;
  attempts: number;
}

/**
 * Durable background task. With a `dedupeKey`, an existing pending task with the same key is kept
 * (its run_at moves earlier if the new one is due sooner), which gives debouncing for free.
 */
export async function enqueueTask(
  q: Queryable,
  kind: TaskKind,
  payload: Record<string, unknown>,
  runAt: Date,
  dedupeKey?: string,
): Promise<void> {
  if (!dedupeKey) {
    await q.query('insert into tasks (id, kind, payload, run_at) values ($1, $2, $3, $4)', [uuid(), kind, JSON.stringify(payload), runAt]);
    return;
  }
  await q.query(
    `insert into tasks (id, kind, dedupe_key, payload, run_at) values ($1, $2, $3, $4, $5)
     on conflict (dedupe_key) do update set
       run_at = case when tasks.state = 'pending' then least(tasks.run_at, excluded.run_at) else excluded.run_at end,
       payload = excluded.payload,
       state = case when tasks.state in ('done','failed') then 'pending' else tasks.state end,
       attempts = case when tasks.state in ('done','failed') then 0 else tasks.attempts end`,
    [uuid(), kind, dedupeKey, JSON.stringify(payload), runAt],
  );
}

export async function claimTasks(db: Db, now: Date, limit: number, leaseMs = 5 * 60_000): Promise<TaskRow[]> {
  const { rows } = await db.query<TaskRow>(
    `update tasks set state = 'running', lease_until = $2, attempts = attempts + 1
     where id in (
       select id from tasks
       where (state = 'pending' and run_at <= $1) or (state = 'running' and lease_until < $1)
       order by run_at limit $3 for update skip locked)
     returning id, kind, dedupe_key, payload, run_at, attempts`,
    [now, addMs(now, leaseMs), limit],
  );
  return rows;
}

/** A task re-enqueued while running (run_at moved past the claimed run_at) goes back to pending. */
export async function completeTask(db: Db, task: TaskRow): Promise<void> {
  await db.query(
    `update tasks set state = case when run_at > $2 then 'pending' else 'done' end, lease_until = null where id = $1`,
    [task.id, task.run_at],
  );
}

export async function rescheduleTask(db: Db, id: string, runAt: Date, error?: string): Promise<void> {
  await db.query(`update tasks set state = 'pending', run_at = $2, lease_until = null, last_error = $3 where id = $1`, [id, runAt, error ?? null]);
}

export async function failTask(db: Db, id: string, error: string): Promise<void> {
  await db.query(`update tasks set state = 'failed', lease_until = null, last_error = $2 where id = $1`, [id, error]);
}
