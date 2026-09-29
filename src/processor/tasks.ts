import type { AppContext } from '../app/context.js';
import { refreshGroupMeta } from '../core/groups.js';
import { completeTask, failTask, rescheduleTask, type TaskRow } from '../core/tasks.js';
import type { OriginMeta } from '../line/types.js';
import type { MediaMessage } from '../media/types.js';
import { addMs } from '../util/clock.js';

export async function processTask(ctx: AppContext, task: TaskRow): Promise<void> {
  try {
    switch (task.kind) {
      case 'media_fetch':
        await handleMediaFetch(ctx, task);
        break;
      case 'imageset_flush':
        await handleImageSetFlush(ctx, task);
        break;
      case 'group_meta':
        await refreshGroupMeta(ctx, task.payload['groupId'] as string);
        await completeTask(ctx.db, task);
        break;
      case 'group_count':
        await refreshGroupMeta(ctx, task.payload['groupId'] as string, { countOnly: true });
        await completeTask(ctx.db, task);
        break;
      default:
        await completeTask(ctx.db, task);
    }
  } catch (err) {
    ctx.log.error({ err, taskId: task.id, kind: task.kind }, 'task processing failed');
    if (task.attempts >= 5) {
      await failTask(ctx.db, task.id, err instanceof Error ? err.message : String(err));
    } else {
      await rescheduleTask(ctx.db, task.id, addMs(ctx.clock.now(), 5000 * 2 ** task.attempts), err instanceof Error ? err.message : String(err));
    }
  }
}

async function handleMediaFetch(ctx: AppContext, task: TaskRow): Promise<void> {
  const p = task.payload as {
    messageId: string;
    type: string;
    meta: OriginMeta;
    firstAttemptAt: string;
    imageSetId?: string;
  };

  const msg: MediaMessage = {
    messageId: p.messageId,
    type: p.type,
    meta: p.meta,
    firstAttemptAt: new Date(p.firstAttemptAt),
  };

  const outcome = await ctx.media.fetchForMessage(msg);
  if (outcome.state === 'pending') {
    await rescheduleTask(ctx.db, task.id, addMs(ctx.clock.now(), outcome.retryInMs));
    return;
  }

  const newState = outcome.state === 'ready' ? 'ready' : 'failed';
  await ctx.db.tx(async (q) => {
    await q.query(`update origin_messages set media_state = $2 where message_id = $1`, [p.messageId, newState]);

    // If not in an imageSet, release waiting jobs immediately
    if (!p.imageSetId) {
      await q.query(
        `update relay_jobs j set
           state = case when b.delivery_mode in ('economy','strict_economy') then 'held' else 'queued' end
         from bridges b
         where j.origin_message_id = $1 and j.state = 'waiting' and b.id = j.bridge_id`,
        [p.messageId],
      );
    }
  });

  // If in an imageSet, check if the full set is ready
  if (p.imageSetId) {
    await checkImageSetReady(ctx, p.imageSetId);
  }

  await completeTask(ctx.db, task);
}

async function checkImageSetReady(ctx: AppContext, setId: string): Promise<void> {
  const { rows } = await ctx.db.query<{
    message_id: string;
    media_state: string;
    meta: OriginMeta;
    event_ts: Date;
  }>(
    `select message_id, media_state, meta, event_ts from origin_messages where image_set_id = $1 order by (meta->'imageSet'->>'index')::int`,
    [setId],
  );

  if (rows.length === 0) return;
  const first = rows[0]!;
  const expectedTotal = first.meta.imageSet?.total ?? rows.length;

  // If all expected images arrived and their media is settled (ready or failed), release them!
  const allArrived = rows.length >= expectedTotal;
  const allSettled = rows.every((r) => r.media_state === 'ready' || r.media_state === 'failed');

  if (allArrived && allSettled) {
    await releaseImageSet(ctx, rows);
  }
}

async function handleImageSetFlush(ctx: AppContext, task: TaskRow): Promise<void> {
  const setId = task.payload['setId'] as string;
  if (!setId) {
    await completeTask(ctx.db, task);
    return;
  }

  const { rows } = await ctx.db.query<{
    message_id: string;
    media_state: string;
    meta: OriginMeta;
    event_ts: Date;
  }>(
    `select message_id, media_state, meta, event_ts from origin_messages where image_set_id = $1 order by coalesce((meta->'imageSet'->>'index')::int, 0), event_ts`,
    [setId],
  );

  if (rows.length > 0) {
    await releaseImageSet(ctx, rows);
  }
  await completeTask(ctx.db, task);
}

async function releaseImageSet(
  ctx: AppContext,
  rows: Array<{ message_id: string; meta: OriginMeta; event_ts: Date }>,
): Promise<void> {
  const earliestTs = rows.reduce((min, r) => (r.event_ts < min ? r.event_ts : min), rows[0]!.event_ts);

  await ctx.db.tx(async (q) => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const index = r.meta.imageSet?.index ?? i + 1;
      await q.query(
        `update relay_jobs j set
           state = case when b.delivery_mode in ('economy','strict_economy') then 'held' else 'queued' end,
           order_ts = $2,
           order_idx = $3
         from bridges b
         where j.origin_message_id = $1 and j.state = 'waiting' and b.id = j.bridge_id`,
        [r.message_id, earliestTs, index],
      );
    }
  });
}
