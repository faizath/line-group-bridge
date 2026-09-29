import type { AppContext } from '../app/context.js';
import type { LineUserRow } from '../core/rows.js';

export interface UserExport {
  user: LineUserRow | null;
  memberships: Array<{ groupId: string; groupName: string | null; lastSeenAt: Date }>;
  messageCount: number;
}

export async function exportUserData(ctx: AppContext, userId: string): Promise<UserExport> {
  const { rows: userRows } = await ctx.db.query<LineUserRow>('select * from line_users where user_id = $1', [userId]);
  const user = userRows[0] ?? null;

  const { rows: memberships } = await ctx.db.query<{ group_id: string; name: string | null; last_seen_at: Date }>(
    `select gm.group_id, g.name, gm.last_seen_at
     from group_memberships gm
     left join member_groups g on g.group_id = gm.group_id
     where gm.user_id = $1 and gm.left_at is null`,
    [userId],
  );

  const { rows: countRows } = await ctx.db.query<{ n: number }>(
    'select count(*) as n from origin_messages where user_id = $1',
    [userId],
  );

  return {
    user,
    memberships: memberships.map((m) => ({ groupId: m.group_id, groupName: m.name, lastSeenAt: m.last_seen_at })),
    messageCount: countRows[0]?.n ?? 0,
  };
}

export interface ErasureResult {
  userId: string;
  purgedMessages: number;
  deletedMemberships: number;
  deletedRoles: number;
  profileDeleted: boolean;
}

export async function eraseUserData(ctx: AppContext, userId: string): Promise<ErasureResult> {
  const now = ctx.clock.now();

  const user = (await ctx.db.query<LineUserRow>('select * from line_users where user_id = $1', [userId])).rows[0];
  if (user?.icon_object_key) {
    await ctx.media.purgeMessage(user.icon_object_key);
  }

  // Find messages authored by this user
  const { rows: userMsgs } = await ctx.db.query<{ message_id: string }>(
    'select message_id from origin_messages where user_id = $1',
    [userId],
  );

  // Purge media for all those messages
  for (const m of userMsgs) {
    await ctx.media.purgeMessage(m.message_id);
  }

  // Null out text, meta, user_id from origin_messages, keeping tombstone IDs
  const msgs = await ctx.db.query(
    `update origin_messages set text = null, meta = null, user_id = null, purged_at = coalesce(purged_at, $2)
     where user_id = $1`,
    [userId, now],
  );

  const memberships = await ctx.db.query('delete from group_memberships where user_id = $1', [userId]);
  const roles = await ctx.db.query('delete from bridge_admins where user_id = $1', [userId]);
  const mutes = await ctx.db.query('delete from bridge_mutes where user_id = $1', [userId]);
  void mutes;

  const profile = await ctx.db.query('delete from line_users where user_id = $1', [userId]);

  return {
    userId,
    purgedMessages: msgs.rowCount,
    deletedMemberships: memberships.rowCount,
    deletedRoles: roles.rowCount,
    profileDeleted: profile.rowCount > 0,
  };
}
