import type { AppContext } from '../app/context.js';
import type { Commands } from '../commands/handler.js';
import { attachedGroups, getBridge, getGroup, registerGroup } from '../core/groups.js';
import { insertJobs, jobTiming } from '../core/jobs.js';
import { registerToken } from '../core/replyTokens.js';
import { enqueueTask } from '../core/tasks.js';
import { ensureProfile, isSilenced, touchUser } from '../core/users.js';
import type { Lanes } from '../delivery/lanes.js';
import type { LineEvent, OriginMeta } from '../line/types.js';
import { checkFlood, FLOOD_COALESCE_MS } from '../moderation/flood.js';
import { addMs } from '../util/clock.js';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

export async function handleMessage(
  ctx: AppContext,
  lanes: Lanes,
  commands: Commands,
  ev: LineEvent,
  receivedAt: Date,
): Promise<void> {
  const groupId = ev.source?.groupId;
  if (!groupId) return;
  const msg = ev.message;
  if (!msg) return;

  // Loop safety: never relay events sent by the bot itself (FR-RLY-6).
  if (ev.source?.userId && ctx.bot.userId && ev.source.userId === ctx.bot.userId) {
    return;
  }

  const now = ctx.clock.now();
  const eventTs = new Date(ev.timestamp);

  // Ensure group exists
  let group = await getGroup(ctx.db, groupId);
  if (!group || group.state === 'bot_removed') {
    group = await registerGroup(ctx.db, ctx, groupId, eventTs);
    await enqueueTask(ctx.db, 'group_meta', { groupId }, now, `meta:${groupId}`);
  }

  // Ensure user is recorded
  if (ev.source?.userId) {
    await touchUser(ctx.db, ev.source.userId, groupId, eventTs);
  }

  // 1. Check if the message is a command
  const cmd = commands.parse(msg);
  if (cmd) {
    await commands.handle(
      {
        groupId,
        userId: ev.source?.userId ?? null,
        message: msg,
        replyToken: ev.replyToken ?? null,
        webhookEventId: ev.webhookEventId,
        receivedAt,
      },
      cmd,
    );
    // Commands are never relayed (FR-CMD-2).
    return;
  }

  // 2. Register reply token for outbox flushes (FR-COST-3)
  if (ev.replyToken) {
    await registerToken(ctx.db, ev.replyToken, groupId, ev.webhookEventId, receivedAt);
    await lanes.processLane(groupId);
  }

  // 3. Check bridge attachment
  if (group.state !== 'attached' || !group.bridge_id || !group.relay_out) {
    return;
  }
  const bridge = await getBridge(ctx.db, group.bridge_id);
  if (!bridge || bridge.status !== 'active') return;

  // 4. Silencing / Opt-out
  let silenced = false;
  if (ev.source?.userId) {
    silenced = await isSilenced(ctx.db, bridge.id, ev.source.userId);
  }

  // 5. Flood control (FR-MOD-3, US-16)
  let floodDelayMs = 0;
  if (!silenced) {
    const verdict = await checkFlood(ctx, groupId, ev.source?.userId ?? null, eventTs);
    if (verdict.action === 'drop') {
      silenced = true;
      if (verdict.notify && ev.replyToken) {
        // Send rate-limit warning
        ctx.log.warn({ groupId, userId: ev.source?.userId }, 'user message dropped by flood control');
      }
    } else if (verdict.action === 'coalesce') {
      floodDelayMs = FLOOD_COALESCE_MS;
    }
  }

  // 6. Ensure sender profile is cached for attribution (NFR-PERF-5: cached, does not block other lanes)
  if (ev.source?.userId && !silenced) {
    await ensureProfile(ctx, groupId, ev.source.userId);
  }

  const meta: OriginMeta = {
    emojis: msg.emojis,
    mentionees: msg.mention?.mentionees,
    sticker: msg.type === 'sticker' ? { packageId: msg.packageId ?? '', stickerId: msg.stickerId ?? '', text: msg.text, keywords: msg.keywords } : undefined,
    imageSet: msg.imageSet,
    contentProvider: msg.contentProvider,
    durationMs: msg.duration,
    file: msg.fileName ? { name: msg.fileName, size: msg.fileSize ?? 0 } : undefined,
    location: msg.type === 'location' ? { title: msg.title, address: msg.address, latitude: msg.latitude ?? 0, longitude: msg.longitude ?? 0 } : undefined,
  };

  const isMedia = MEDIA_TYPES.has(msg.type);
  const mediaState = isMedia ? 'pending' : 'none';

  // 7. Store origin message
  await ctx.db.query(
    `insert into origin_messages (message_id, bridge_id, group_id, user_id, type, event_ts, quote_token, quoted_message_id, text, meta, relayed, media_state, image_set_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (message_id) do nothing`,
    [
      msg.id,
      bridge.id,
      groupId,
      ev.source?.userId ?? null,
      msg.type,
      eventTs,
      msg.quoteToken ?? null,
      msg.quotedMessageId ?? null,
      msg.text ?? null,
      JSON.stringify(meta),
      !silenced,
      mediaState,
      msg.imageSet?.id ?? null,
    ],
  );

  if (silenced) return;

  // 8. Create relay jobs for target groups
  const targets = await attachedGroups(ctx.db, bridge.id);
  const timing = jobTiming(bridge, now);
  const readyAt = addMs(timing.readyAt, floodDelayMs);
  const isWaiting = isMedia || Boolean(msg.imageSet);
  const initialJobState = isWaiting ? 'waiting' : timing.state;

  const newJobs = targets
    .filter((t) => t.group_id !== groupId && t.relay_in)
    .map((t) => ({
      bridgeId: bridge.id,
      originMessageId: msg.id,
      originGroupId: groupId,
      targetGroupId: t.group_id,
      kind: 'relay' as const,
      state: initialJobState,
      orderTs: eventTs,
      orderIdx: msg.imageSet?.index ?? 0,
      readyAt,
    }));

  await insertJobs(ctx.db, newJobs);

  // 9. Enqueue media tasks if needed
  if (isMedia) {
    await enqueueTask(
      ctx.db,
      'media_fetch',
      {
        messageId: msg.id,
        type: msg.type,
        meta,
        firstAttemptAt: now.toISOString(),
        imageSetId: msg.imageSet?.id,
      },
      now,
    );
  }

  // 10. Buffer image sets
  if (msg.imageSet?.id) {
    // Flush after 10 s if total not reached (FR-MSG-6)
    await enqueueTask(
      ctx.db,
      'imageset_flush',
      { setId: msg.imageSet.id, bridgeId: bridge.id },
      addMs(now, 10_000),
      `imageset:${msg.imageSet.id}`,
    );
  }

  // 11. If in immediate mode and jobs are ready now, prompt lanes
  if (bridge.delivery_mode === 'immediate' && !isWaiting) {
    for (const target of targets) {
      if (target.group_id !== groupId && target.relay_in) {
        setImmediate(() => lanes.processLane(target.group_id).catch(() => undefined));
      }
    }
  }
}
