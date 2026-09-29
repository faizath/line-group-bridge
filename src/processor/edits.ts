import type { AppContext } from '../app/context.js';
import { attachedGroups, getBridge } from '../core/groups.js';
import { insertJobs, jobTiming } from '../core/jobs.js';
import { registerToken } from '../core/replyTokens.js';
import type { OriginRow } from '../core/rows.js';
import type { Lanes } from '../delivery/lanes.js';
import type { LineEvent } from '../line/types.js';

export type EditOutcome = 'done' | 'park' | 'dropped';

export async function handleEdit(ctx: AppContext, lanes: Lanes, ev: LineEvent, receivedAt: Date): Promise<EditOutcome> {
  const msg = ev.message;
  if (!msg || typeof msg.id !== 'string') return 'dropped';
  const now = ctx.clock.now();

  const { rows } = await ctx.db.query<OriginRow>('select * from origin_messages where message_id = $1', [msg.id]);
  const origin = rows[0];
  if (!origin) {
    // If message is unknown, park for up to 60 s awaiting the original (out-of-order delivery, FR-ING-9, [07] §3.1).
    return 'park';
  }

  if (origin.unsent_at) {
    return 'dropped';
  }

  const newText = msg.text ?? '';
  const newMeta = {
    emojis: msg.emojis,
    mentionees: msg.mention?.mentionees,
  };
  const newEditCount = origin.edit_count + 1;

  await ctx.db.query(
    `update origin_messages set
       text = $2,
       quote_token = coalesce($3, quote_token),
       meta = $4,
       edited_at = $5,
       edit_count = $6
     where message_id = $1`,
    [msg.id, newText, msg.quoteToken ?? null, JSON.stringify(newMeta), now, newEditCount],
  );

  const bridge = await getBridge(ctx.db, origin.bridge_id);
  if (bridge && bridge.status === 'active') {
    const targets = await attachedGroups(ctx.db, bridge.id);
    const timing = jobTiming(bridge, now);

    for (const target of targets) {
      if (target.group_id === origin.group_id || !target.relay_in) continue;

      // Check if target has an already delivered copy
      const copy = await ctx.db.query(
        `select 1 from relay_copies where target_group_id = $1 and origin_message_id = $2 limit 1`,
        [target.group_id, origin.message_id],
      );
      if (copy.rowCount > 0) {
        const ins = await insertJobs(ctx.db, [
          {
            bridgeId: bridge.id,
            originMessageId: origin.message_id,
            originGroupId: origin.group_id,
            targetGroupId: target.group_id,
            kind: 'edit',
            state: timing.state,
            orderTs: now,
            readyAt: timing.readyAt,
            seq: newEditCount,
          },
        ]);
        ctx.log.info({ ins, copyCount: copy.rowCount, targetId: target.group_id }, 'handleEdit insertJobs');
      }
    }
  }

  if (ev.replyToken) {
    const groupId = ev.source?.groupId ?? origin.group_id;
    await registerToken(ctx.db, ev.replyToken, groupId, ev.webhookEventId, receivedAt);
    await lanes.processLane(groupId);
  }

  return 'done';
}
