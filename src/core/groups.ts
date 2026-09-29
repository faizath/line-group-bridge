import type { AppContext } from '../app/context.js';
import type { Queryable } from '../db/db.js';
import { LineApiError } from '../line/adapter.js';
import type { BridgeRow, GroupRow } from './rows.js';

// Metadata refresh cadence (FR-BRG-6).
export const META_REFRESH_MS = 6 * 60 * 60 * 1000;
export const COUNT_DEBOUNCE_MS = 60_000;

export async function getGroup(q: Queryable, groupId: string): Promise<GroupRow | null> {
  const { rows } = await q.query<GroupRow>('select * from member_groups where group_id = $1', [groupId]);
  return rows[0] ?? null;
}

export async function getBridge(q: Queryable, bridgeId: string): Promise<BridgeRow | null> {
  const { rows } = await q.query<BridgeRow>('select * from bridges where id = $1', [bridgeId]);
  return rows[0] ?? null;
}

/** Attached member groups of a bridge in tag order. */
export async function attachedGroups(q: Queryable, bridgeId: string): Promise<GroupRow[]> {
  const { rows } = await q.query<GroupRow>(
    `select * from member_groups where bridge_id = $1 and state = 'attached' order by attached_at, group_id`,
    [bridgeId],
  );
  return rows;
}

/**
 * Registers a group the bot is in. New or re-invited (bot_removed) groups become `unattached`;
 * groups already known in another state keep it (e.g. a redelivered join event).
 */
export async function registerGroup(q: Queryable, ctx: AppContext, groupId: string, at: Date): Promise<GroupRow> {
  const { rows } = await q.query<GroupRow>(
    `insert into member_groups (group_id, channel_id, state, joined_at) values ($1, $2, 'unattached', $3)
     on conflict (group_id) do update set
       state = case when member_groups.state = 'bot_removed' then 'unattached' else member_groups.state end,
       bridge_id = case when member_groups.state = 'bot_removed' then null else member_groups.bridge_id end,
       short_tag = case when member_groups.state = 'bot_removed' then null else member_groups.short_tag end,
       joined_at = case when member_groups.state = 'bot_removed' then excluded.joined_at else member_groups.joined_at end
     returning *`,
    [groupId, ctx.config.channelId, at],
  );
  return rows[0]!;
}

/** Next free short tag: A..Z, then AA, AB, … (FR-ATT-2 origin tags). */
export async function nextShortTag(q: Queryable, bridgeId: string): Promise<string> {
  const { rows } = await q.query<{ short_tag: string }>(
    'select short_tag from member_groups where bridge_id = $1 and short_tag is not null',
    [bridgeId],
  );
  const used = new Set(rows.map((r) => r.short_tag));
  for (let n = 0; ; n++) {
    const tag = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26));
    if (!used.has(tag)) return tag;
  }
}

/**
 * Stops relays to and from a group: cancels its queued outbound work and returns the
 * bridge it left (FR-BRG-4, US-4).
 */
export async function cancelTargetJobs(q: Queryable, groupId: string, reason: string): Promise<number> {
  const r = await q.query(
    `update relay_jobs set state = 'cancelled', last_error = $2
     where target_group_id = $1 and state in ('waiting','queued','held')`,
    [groupId, reason],
  );
  return r.rowCount;
}

/** Fetches name, icon and member count from LINE (FR-BRG-3, FR-BRG-6). Failures are logged, not thrown. */
export async function refreshGroupMeta(ctx: AppContext, groupId: string, opts: { countOnly?: boolean } = {}): Promise<void> {
  const now = ctx.clock.now();
  try {
    const count = await ctx.line.getGroupMemberCount(groupId);
    if (opts.countOnly) {
      await ctx.db.query('update member_groups set member_count = $2 where group_id = $1', [groupId, count]);
      return;
    }
    const summary = await ctx.line.getGroupSummary(groupId);
    await ctx.db.query(
      `update member_groups set name = $2, picture_url = $3, member_count = $4, meta_refreshed_at = $5 where group_id = $1`,
      [groupId, summary.groupName, summary.pictureUrl ?? null, count, now],
    );
  } catch (err) {
    if (err instanceof LineApiError && (err.status === 404 || err.status === 403)) {
      ctx.log.warn({ groupId, status: err.status }, 'group metadata unavailable; bot may no longer be in the group');
      return;
    }
    ctx.log.warn({ err, groupId }, 'group metadata refresh failed');
  }
}

export function groupLabel(g: Pick<GroupRow, 'name' | 'short_tag' | 'group_id'>): string {
  return g.name ?? (g.short_tag ? `#${g.short_tag}` : g.group_id.slice(0, 8));
}
