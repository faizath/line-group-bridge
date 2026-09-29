import type { Queryable } from '../db/db.js';
import type { OriginRow } from '../core/rows.js';
import type { Translate } from '../i18n/index.js';
import { snippetFor } from '../translate/translate.js';
import type { QuoteInfo } from '../translate/types.js';

/**
 * Maps a quoted message ID (as seen in the origin group) to the canonical origin message:
 * either it is an origin message itself, or a relayed copy in that group ([08] §2.4).
 */
export async function canonicalOrigin(q: Queryable, quotedMessageId: string, groupId: string): Promise<OriginRow | null> {
  const direct = await q.query<OriginRow>('select * from origin_messages where message_id = $1', [quotedMessageId]);
  if (direct.rows[0]) return direct.rows[0];
  const viaCopy = await q.query<OriginRow>(
    `select o.* from relay_copies c join origin_messages o on o.message_id = c.origin_message_id
     where c.target_group_id = $1 and c.sent_message_id = $2 limit 1`,
    [groupId, quotedMessageId],
  );
  return viaCopy.rows[0] ?? null;
}

/** Quote token usable in `targetGroupId` for the origin message: its own token in the origin group, else the target copy's. */
export async function quoteTokenIn(q: Queryable, origin: OriginRow, targetGroupId: string): Promise<string | null> {
  if (origin.group_id === targetGroupId) return origin.quote_token;
  const { rows } = await q.query<{ quote_token: string | null }>(
    `select quote_token from relay_copies where target_group_id = $1 and origin_message_id = $2 and quote_token is not null
     order by part_index limit 1`,
    [targetGroupId, origin.message_id],
  );
  return rows[0]?.quote_token ?? null;
}

async function authorName(q: Queryable, userId: string | null, t: Translate): Promise<string> {
  if (!userId) return t('line_user');
  const { rows } = await q.query<{ display_name: string | null }>('select display_name from line_users where user_id = $1', [userId]);
  return rows[0]?.display_name ?? t('line_user');
}

/** Quote info for relaying a reply-quote into the target (FR-EVT-1/2, US-9). */
export async function resolveQuote(
  q: Queryable,
  quotedMessageId: string,
  originGroupId: string,
  targetGroupId: string,
  t: Translate,
): Promise<QuoteInfo> {
  const canonical = await canonicalOrigin(q, quotedMessageId, originGroupId);
  if (!canonical) return { quoteToken: null, authorName: t('line_user'), snippet: t('snippet_message') };
  const visible = canonical.unsent_at === null && canonical.relayed;
  return {
    quoteToken: canonical.unsent_at === null ? await quoteTokenIn(q, canonical, targetGroupId) : null,
    authorName: await authorName(q, canonical.user_id, t),
    snippet: visible ? snippetFor({ type: canonical.type, text: canonical.text }, t) : t('snippet_message'),
  };
}

/** Quote info for an edit notice: the target's copy of the edited message itself (FR-EVT-3). */
export async function resolveEditQuote(q: Queryable, origin: OriginRow, targetGroupId: string, t: Translate): Promise<QuoteInfo> {
  return {
    quoteToken: await quoteTokenIn(q, origin, targetGroupId),
    authorName: await authorName(q, origin.user_id, t),
    snippet: snippetFor({ type: origin.type, text: origin.text }, t),
  };
}
