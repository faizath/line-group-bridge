import type { AppContext } from '../app/context.js';
import type { Queryable } from '../db/db.js';
import type { LineUserRow } from './rows.js';

// Profile cache TTL (FR-ATT-5).
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

/** Records that a user was seen in a group (best-effort membership, FR-EVT-5). */
export async function touchUser(q: Queryable, userId: string, groupId: string, at: Date): Promise<void> {
  await q.query(
    `insert into line_users (user_id, last_seen_at) values ($1, $2)
     on conflict (user_id) do update set last_seen_at = greatest(line_users.last_seen_at, excluded.last_seen_at)`,
    [userId, at],
  );
  await q.query(
    `insert into group_memberships (group_id, user_id, last_seen_at) values ($1, $2, $3)
     on conflict (group_id, user_id) do update set last_seen_at = greatest(group_memberships.last_seen_at, excluded.last_seen_at), left_at = null`,
    [groupId, userId, at],
  );
}

export async function getUser(q: Queryable, userId: string): Promise<LineUserRow | null> {
  const { rows } = await q.query<LineUserRow>('select * from line_users where user_id = $1', [userId]);
  return rows[0] ?? null;
}

/**
 * Returns the cached profile, refreshing it from LINE when older than the TTL. The group
 * member profile endpoint works without friendship (FR-ATT-5). Avatars are re-hosted as PNG
 * (FR-ATT-4). Failures keep the stale profile.
 */
export async function ensureProfile(ctx: AppContext, groupId: string, userId: string): Promise<LineUserRow | null> {
  const now = ctx.clock.now();
  const cached = await getUser(ctx.db, userId);
  if (cached?.profile_fetched_at && now.getTime() - cached.profile_fetched_at.getTime() < PROFILE_TTL_MS) return cached;
  try {
    const profile = await ctx.line.getGroupMemberProfile(groupId, userId);
    if (!profile) return cached;
    let iconKey = cached?.icon_object_key ?? null;
    let iconHash = cached?.icon_hash ?? null;
    if (!profile.pictureUrl) {
      iconKey = null;
      iconHash = null;
    } else if (profile.pictureUrl !== cached?.picture_url || !iconKey) {
      const icon = await ctx.media.ensureAvatar(profile.pictureUrl);
      iconKey = icon?.objectKey ?? null;
      iconHash = icon?.hash ?? null;
    }
    const { rows } = await ctx.db.query<LineUserRow>(
      `insert into line_users (user_id, display_name, picture_url, icon_object_key, icon_hash, profile_fetched_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $6)
       on conflict (user_id) do update set display_name = $2, picture_url = $3, icon_object_key = $4, icon_hash = $5, profile_fetched_at = $6
       returning *`,
      [userId, profile.displayName, profile.pictureUrl ?? null, iconKey, iconHash, now],
    );
    return rows[0] ?? cached;
  } catch (err) {
    ctx.log.warn({ err, userId }, 'profile refresh failed');
    return cached;
  }
}

/** True when the user's messages must not be relayed in this bridge (FR-MOD-2, FR-PRIV-2). */
export async function isSilenced(q: Queryable, bridgeId: string, userId: string): Promise<boolean> {
  const { rows } = await q.query<{ silenced: boolean }>(
    `select exists(select 1 from bridge_mutes where bridge_id = $1 and user_id = $2)
         or coalesce((select opted_out from line_users where user_id = $2), false) as silenced`,
    [bridgeId, userId],
  );
  return rows[0]?.silenced === true;
}
