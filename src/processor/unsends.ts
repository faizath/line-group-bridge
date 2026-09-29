import type { AppContext } from '../app/context.js';
import { getBridge } from '../core/groups.js';
import { enqueueUnsendNotice } from '../delivery/lanes.js';
import type { OriginRow } from '../core/rows.js';
import { translator } from '../i18n/index.js';
import type { LineEvent } from '../line/types.js';

export type UnsendOutcome = 'done' | 'park' | 'dropped';

export async function handleUnsend(ctx: AppContext, ev: LineEvent): Promise<UnsendOutcome> {
  const messageId = ev.unsend?.messageId;
  if (!messageId) return 'dropped';
  const now = ctx.clock.now();

  const { rows } = await ctx.db.query<OriginRow>('select * from origin_messages where message_id = $1', [messageId]);
  const origin = rows[0];
  if (!origin) {
    return 'park';
  }

  if (origin.unsent_at) {
    return 'done';
  }

  await ctx.db.tx(async (q) => {
    // 1. Mark origin message unsent and purge text/meta
    await q.query(
      `update origin_messages set unsent_at = $2, text = null, meta = null where message_id = $1`,
      [messageId, now],
    );

    // 2. Cancel pending relay/edit jobs (FR-EVT-4a)
    await q.query(
      `update relay_jobs set state = 'cancelled', last_error = 'unsent by author'
       where origin_message_id = $1 and state in ('waiting','queued','held')`,
      [messageId],
    );

    // 3. Scrub text from inbound event payloads for privacy compliance (NFR-PRIV-2, PRD/11 §3.3)
    await q.query(
      `update inbound_events set payload = jsonb_set(payload, '{message,text}', 'null'::jsonb)
       where payload->'message'->>'id' = $1`,
      [messageId],
    );
  });

  // 4. Purge media from storage and media_objects
  await ctx.media.purgeMessage(messageId);

  // 5. Post unquoted notice to target groups that already received the message (FR-EVT-4c, ADR-005)
  const bridge = await getBridge(ctx.db, origin.bridge_id);
  if (bridge && bridge.notices_unsend) {
    const delivered = await ctx.db.query<{ target_group_id: string }>(
      `select distinct target_group_id from relay_copies where origin_message_id = $1`,
      [messageId],
    );

    if (delivered.rows.length > 0) {
      let authorName: string | null = null;
      if (origin.user_id) {
        const u = await ctx.db.query<{ display_name: string | null }>(
          'select display_name from line_users where user_id = $1',
          [origin.user_id],
        );
        authorName = u.rows[0]?.display_name ?? null;
      }
      const author = authorName ?? translator(bridge.locale)('line_user');

      for (const d of delivered.rows) {
        await enqueueUnsendNotice(ctx.db, bridge, messageId, d.target_group_id, author, now);
      }
    }
  }

  return 'done';
}
