import type { AppContext } from '../app/context.js';
import { getState, setState } from '../core/state.js';

const WINDOW_MS = 60_000;
/** Extra delay applied to relays from a flooding group so they coalesce into digests. */
export const FLOOD_COALESCE_MS = 60_000;

export type FloodVerdict =
  /** Relay normally. */
  | { action: 'ok' }
  /** The origin group exceeds its rate: relay, but delay so relays coalesce into digests. */
  | { action: 'coalesce' }
  /** The sender exceeds the per-user rate: don't relay. `notify` is true once per window. */
  | { action: 'drop'; notify: boolean };

/**
 * Flood control (FR-MOD-3, US-16): per-origin-group and per-user message rates over the last
 * minute, counted from stored origin messages (including this one).
 */
export async function checkFlood(ctx: AppContext, groupId: string, userId: string | null, at: Date): Promise<FloodVerdict> {
  const since = new Date(at.getTime() - WINDOW_MS);
  if (userId) {
    const { rows } = await ctx.db.query<{ n: number }>(
      'select count(*) as n from origin_messages where group_id = $1 and user_id = $2 and event_ts > $3',
      [groupId, userId, since],
    );
    if ((rows[0]?.n ?? 0) >= ctx.config.FLOOD_USER_PER_MIN) {
      const key = `flood_notice:${groupId}:${userId}`;
      const last = await getState<{ at: string }>(ctx.db, key);
      const notify = !last || at.getTime() - Date.parse(last.at) > WINDOW_MS;
      if (notify) await setState(ctx.db, key, { at: at.toISOString() }, at);
      return { action: 'drop', notify };
    }
  }
  const { rows } = await ctx.db.query<{ n: number }>('select count(*) as n from origin_messages where group_id = $1 and event_ts > $2', [
    groupId,
    since,
  ]);
  if ((rows[0]?.n ?? 0) >= ctx.config.FLOOD_GROUP_PER_MIN) return { action: 'coalesce' };
  return { action: 'ok' };
}
