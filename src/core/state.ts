import type { Queryable } from '../db/db.js';

/** Small JSON key/value store for process-shared flags (quota stop, alert bookkeeping). */
export async function getState<T>(q: Queryable, key: string): Promise<T | null> {
  const { rows } = await q.query<{ value: T }>('select value from system_state where key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setState(q: Queryable, key: string, value: unknown, now: Date): Promise<void> {
  await q.query(
    `insert into system_state (key, value, updated_at) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now],
  );
}
