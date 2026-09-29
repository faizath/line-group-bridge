import type { AppContext } from '../app/context.js';
import type { Commands } from '../commands/handler.js';
import type { Lanes } from '../delivery/lanes.js';
import { registerToken } from '../core/replyTokens.js';
import type { LineEvent } from '../line/types.js';
import { alert } from '../logger.js';
import { addMs } from '../util/clock.js';
import { handleEdit } from './edits.js';
import { handleJoin, handleLeave, handleMemberJoined, handleMemberLeft } from './lifecycle.js';
import { handleMessage } from './message.js';
import { handleUnsend } from './unsends.js';

const BATCH_LIMIT = 20;
const LEASE_MS = 60_000;
const MAX_PARK_AGE_MS = 60_000;
const PARK_STEP_MS = 5_000;

interface InboundRow {
  webhook_event_id: string;
  channel_id: string;
  type: string;
  group_id: string | null;
  event_ts: Date;
  received_at: Date;
  is_redelivery: boolean;
  payload: LineEvent;
  state: 'pending' | 'claimed' | 'done' | 'parked' | 'failed';
  attempts: number;
}

/**
 * Durable event processor (FR-ING-3, NFR-REL-1/2): claims inbound events from the inbox,
 * routes them to lifecycle, command, message, edit and unsend handlers, and orders them by
 * origin event timestamp.
 */
export class EventProcessor {
  constructor(
    private ctx: AppContext,
    private lanes: Lanes,
    private commands: Commands,
  ) {}

  /** Claims and processes a batch of ready inbound events. Returns the count processed. */
  async runBatch(limit = BATCH_LIMIT): Promise<number> {
    const now = this.ctx.clock.now();
    const { rows } = await this.ctx.db.query<InboundRow>(
      `update inbound_events set
         state = 'claimed',
         lease_until = $2,
         lease_owner = $3,
         attempts = attempts + 1
       where webhook_event_id in (
         select webhook_event_id from inbound_events
         where (state = 'pending')
            or (state = 'claimed' and lease_until < $1)
            or (state = 'parked' and parked_until <= $1)
         order by event_ts, received_at
         limit $4 for update skip locked
       )
       returning webhook_event_id, channel_id, type, group_id, event_ts, received_at, is_redelivery, payload, state, attempts`,
      [now, addMs(now, LEASE_MS), this.ctx.instanceId, limit],
    );

    // Sort by event timestamp (FR-ING-9)
    rows.sort((a, b) => a.event_ts.getTime() - b.event_ts.getTime());

    for (const row of rows) {
      await this.processEvent(row);
    }
    return rows.length;
  }

  private async processEvent(row: InboundRow): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const ev = row.payload;

    try {
      // 1. Ignore standby mode events (FR-ING-6)
      if (ev.mode === 'standby') {
        await this.markDone(row.webhook_event_id, now);
        return;
      }

      // 2. Ignore non-group sources for relaying (FR-ING-7: room logged; user ignored in v1)
      if (ev.source?.type && ev.source.type !== 'group') {
        if (ev.source.type === 'room') {
          ctx.log.info({ webhookEventId: row.webhook_event_id }, 'ignoring legacy room source');
        }
        await this.markDone(row.webhook_event_id, now);
        return;
      }

      // 3. Dispatch by event type
      switch (ev.type) {
        case 'message':
          await handleMessage(ctx, this.lanes, this.commands, ev, row.received_at);
          await this.markDone(row.webhook_event_id, now);
          break;

        case 'messageEdited': {
          const outcome = await handleEdit(ctx, this.lanes, ev, row.received_at);
          if (outcome === 'park') {
            await this.maybePark(row, now);
          } else {
            await this.markDone(row.webhook_event_id, now);
          }
          break;
        }

        case 'unsend': {
          const outcome = await handleUnsend(ctx, ev);
          if (outcome === 'park') {
            await this.maybePark(row, now);
          } else {
            await this.markDone(row.webhook_event_id, now);
          }
          break;
        }

        case 'join':
          await handleJoin(ctx, ev, row.received_at);
          await this.markDone(row.webhook_event_id, now);
          break;

        case 'leave':
          await handleLeave(ctx, ev);
          await this.markDone(row.webhook_event_id, now);
          break;
        case 'memberJoined':
          await handleMemberJoined(ctx, this.lanes, ev, row.received_at);
          await this.markDone(row.webhook_event_id, now);
          break;

        case 'memberLeft':
          await handleMemberLeft(ctx, ev);
          await this.markDone(row.webhook_event_id, now);
          break;

        case 'postback':
          if (ev.replyToken && ev.source?.groupId) {
            await registerToken(ctx.db, ev.replyToken, ev.source.groupId, ev.webhookEventId, row.received_at);
            await this.lanes.processLane(ev.source.groupId);
          }
          await this.markDone(row.webhook_event_id, now);
          break;

        default:
          // Unknown event types are logged and skipped, never crash (FR-ING-8, NFR-REL-8).
          ctx.log.info({ type: ev.type, webhookEventId: row.webhook_event_id }, 'skipping unknown event type');
          await this.markDone(row.webhook_event_id, now);
          break;
      }
    } catch (err) {
      ctx.log.error({ err, webhookEventId: row.webhook_event_id, type: ev.type }, 'event processing failed');
      await this.onError(row, err, now);
    }
  }

  private async markDone(webhookEventId: string, now: Date): Promise<void> {
    await this.ctx.db.query(
      `update inbound_events set state = 'done', processed_at = $2, lease_until = null, lease_owner = null, error = null where webhook_event_id = $1`,
      [webhookEventId, now],
    );
  }

  private async maybePark(row: InboundRow, now: Date): Promise<void> {
    const age = now.getTime() - row.received_at.getTime();
    if (age > MAX_PARK_AGE_MS) {
      // Parked too long awaiting the original message (it never arrived); mark done and log
      this.ctx.log.warn({ webhookEventId: row.webhook_event_id, type: row.type }, 'dropping orphaned event after park timeout');
      await this.markDone(row.webhook_event_id, now);
      return;
    }
    await this.ctx.db.query(
      `update inbound_events set state = 'parked', parked_until = $2, lease_until = null, lease_owner = null where webhook_event_id = $1`,
      [row.webhook_event_id, addMs(now, PARK_STEP_MS)],
    );
  }

  private async onError(row: InboundRow, err: unknown, _now: Date): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (row.attempts >= 5) {
      await this.ctx.db.query(
        `update inbound_events set state = 'failed', error = $2, lease_until = null, lease_owner = null where webhook_event_id = $1`,
        [row.webhook_event_id, errorMsg],
      );
      alert(this.ctx.log, 'inbound_event_failed', { webhookEventId: row.webhook_event_id, error: errorMsg });
    } else {
      await this.ctx.db.query(
        `update inbound_events set state = 'pending', lease_until = null, lease_owner = null, error = $2 where webhook_event_id = $1`,
        [row.webhook_event_id, errorMsg],
      );
    }
  }
}
