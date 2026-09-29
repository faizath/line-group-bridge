import type { AppContext } from '../app/context.js';
import { attachedGroups, cancelTargetJobs, getBridge, getGroup, groupLabel, refreshGroupMeta, registerGroup } from '../core/groups.js';
import { enqueueNotice } from '../core/jobs.js';
import { registerToken, replyMessages } from '../core/replyTokens.js';
import { enqueueTask } from '../core/tasks.js';
import { touchUser } from '../core/users.js';
import type { Lanes } from '../delivery/lanes.js';
import { translator } from '../i18n/index.js';
import type { LineEvent } from '../line/types.js';
import { addMs } from '../util/clock.js';

export async function handleJoin(ctx: AppContext, ev: LineEvent, receivedAt: Date): Promise<void> {
  const groupId = ev.source?.groupId;
  if (!groupId) return;
  await registerGroup(ctx.db, ctx, groupId, new Date(ev.timestamp));

  // Onboarding reply via free reply token (FR-BRG-3, FR-PRIV-1, ADR-006).
  if (ev.replyToken) {
    const claimed = await registerToken(ctx.db, ev.replyToken, groupId, ev.webhookEventId, receivedAt, 'onboarding');
    if (claimed) {
      const t = translator(ctx.config.LOCALE_DEFAULT);
      let text = t('onboarding', {
        name: ctx.bot.userId ?? 'LINE Bridge Bot',
        p: ctx.config.COMMAND_PREFIX,
      });
      if (ctx.config.PRIVACY_URL) {
        text += `\n${t('privacy_line', { url: ctx.config.PRIVACY_URL })}`;
      }
      await replyMessages(ctx, ev.replyToken, [{ type: 'text', text }]);
    }
  }

  // Refresh summary and count
  await refreshGroupMeta(ctx, groupId);
}

export async function handleLeave(ctx: AppContext, ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId;
  if (!groupId) return;
  const now = ctx.clock.now();

  const group = await getGroup(ctx.db, groupId);
  if (!group) return;

  await ctx.db.tx(async (q) => {
    await q.query(`update member_groups set state = 'bot_removed' where group_id = $1`, [groupId]);
    await cancelTargetJobs(q, groupId, 'bot removed from group');
  });

  // Notify other groups if attached (FR-BRG-5, US-4)
  if (group.bridge_id && group.state === 'attached') {
    const bridge = await getBridge(ctx.db, group.bridge_id);
    if (bridge && bridge.notices_leave) {
      const others = (await attachedGroups(ctx.db, bridge.id)).map((g) => g.group_id);
      if (others.length > 0) {
        await enqueueNotice(ctx.db, bridge, others, { key: 'notice_group_left', vars: { group: groupLabel(group) } }, now);
      }
    }
  }
}

export async function handleMemberJoined(ctx: AppContext, lanes: Lanes, ev: LineEvent, receivedAt: Date): Promise<void> {
  const groupId = ev.source?.groupId;
  if (!groupId) return;
  const now = ctx.clock.now();

  const members = ev.joined?.members ?? [];
  for (const m of members) {
    if (m.userId) {
      await touchUser(ctx.db, m.userId, groupId, new Date(ev.timestamp));
    }
  }

  // Debounced count refresh (FR-BRG-6: count only, debounced >= 60 s)
  await enqueueTask(ctx.db, 'group_count', { groupId }, addMs(now, 60_000), `count:${groupId}`);

  // Reply token can be used to flush the group outbox (FR-COST-3)
  if (ev.replyToken) {
    await registerToken(ctx.db, ev.replyToken, groupId, ev.webhookEventId, receivedAt);
    await lanes.processLane(groupId);
  }
}

export async function handleMemberLeft(ctx: AppContext, ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId;
  if (!groupId) return;
  const now = ctx.clock.now();

  const members = ev.left?.members ?? [];
  for (const m of members) {
    if (m.userId) {
      await ctx.db.query(
        `update group_memberships set left_at = $3 where group_id = $1 and user_id = $2`,
        [groupId, m.userId, new Date(ev.timestamp)],
      );
    }
  }

  await enqueueTask(ctx.db, 'group_count', { groupId }, addMs(now, 60_000), `count:${groupId}`);
}
