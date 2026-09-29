import type { AppContext } from '../app/context.js';
import type { Queryable } from '../db/db.js';
import type { OutboundMessage } from '../line/types.js';

// LINE allows ~1 minute but says not to rely on it; older tokens are considered unusable.
export const REPLY_TOKEN_MAX_AGE_MS = 50_000;

export type TokenUse = 'command' | 'outbox' | 'onboarding';

/** Records a reply token as a free delivery slot for its group. Redelivered events carry the same token. */
export async function registerToken(
  q: Queryable,
  token: string,
  groupId: string,
  sourceEvent: string,
  issuedAt: Date,
  claimedBy?: TokenUse,
): Promise<boolean> {
  const r = await q.query(
    `insert into reply_tokens (token, group_id, source_event, issued_at, claimed_by, claimed_at)
     values ($1, $2, $3, $4, $5::text, case when $5::text is null then null else $4::timestamptz end)
     on conflict (token) do nothing`,
    [token, groupId, sourceEvent, issuedAt, claimedBy ?? null],
  );
  return r.rowCount > 0;
}

/** Atomically claims a specific token; each token is used at most once system-wide (FR-COST-4). */
export async function claimToken(q: Queryable, token: string, by: TokenUse, now: Date): Promise<boolean> {
  const r = await q.query(
    `update reply_tokens set claimed_by = $2, claimed_at = $3
     where token = $1 and claimed_at is null and issued_at > $4`,
    [token, by, now, new Date(now.getTime() - REPLY_TOKEN_MAX_AGE_MS)],
  );
  return r.rowCount > 0;
}

/** Claims the newest usable unclaimed token of a group, if any. */
export async function claimFreshToken(q: Queryable, groupId: string, by: TokenUse, now: Date): Promise<string | null> {
  const { rows } = await q.query<{ token: string }>(
    `update reply_tokens set claimed_by = $2, claimed_at = $3
     where token = (
       select token from reply_tokens
       where group_id = $1 and claimed_at is null and issued_at > $4
       order by issued_at desc limit 1 for update skip locked)
     returning token`,
    [groupId, by, now, new Date(now.getTime() - REPLY_TOKEN_MAX_AGE_MS)],
  );
  return rows[0]?.token ?? null;
}

/**
 * Sends bot-authored text through a reply token (free). Failures (expired token) are logged and
 * dropped, never pushed, to avoid cost (ADR-006).
 */
export async function replyMessages(ctx: AppContext, token: string, messages: OutboundMessage[]): Promise<boolean> {
  try {
    await ctx.line.reply(token, messages.slice(0, 5));
    ctx.metrics.relayRequests.inc({ method: 'reply', outcome: 'bot' });
    return true;
  } catch (err) {
    ctx.log.warn({ err }, 'bot reply failed; response dropped');
    return false;
  }
}
