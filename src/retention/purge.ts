import type { AppContext } from '../app/context.js';
import { addMs } from '../util/clock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface PurgeResult {
  scrubbedPayloads: number;
  purgedMessages: number;
  deletedMedia: number;
  deletedCopies: number;
  deletedTokens: number;
  deletedAttempts: number;
  deletedUsers: number;
  deletedLinkCodes: number;
}

/**
 * Enforces data retention schedules (FR-PRIV-3, NFR-PRIV-1..3, [08] §4).
 * Strips personal data from old records and frees storage.
 */
export async function runRetentionPurge(ctx: AppContext, now = ctx.clock.now()): Promise<PurgeResult> {
  const cfg = ctx.config;

  // 1. Scrub message text from old inbound event payloads
  const payloadCutoff = addMs(now, -cfg.RETENTION_PAYLOAD_DAYS * DAY_MS);
  const scrubbed = await ctx.db.query(
    `update inbound_events set payload = jsonb_set(payload, '{message,text}', 'null'::jsonb)
     where received_at < $1 and payload->'message'->'text' is not null and payload->'message'->'text' <> 'null'::jsonb`,
    [payloadCutoff],
  );

  // 2. Null out text and meta from origin_messages older than retention
  const textCutoff = addMs(now, -cfg.RETENTION_TEXT_DAYS * DAY_MS);
  const purgedMsgs = await ctx.db.query(
    `update origin_messages set text = null, meta = null, purged_at = coalesce(purged_at, $2)
     where event_ts < $1 and (text is not null or meta is not null)`,
    [textCutoff, now],
  );

  // 3. Purge expired media objects and underlying files
  const deletedMedia = await ctx.media.purgeExpired(now);

  // 4. Delete relay_copies older than map retention (quotes of older messages fall back to text prefix)
  const mapCutoff = addMs(now, -cfg.RETENTION_MAP_DAYS * DAY_MS);
  const deletedCopies = await ctx.db.query(`delete from relay_copies where created_at < $1`, [mapCutoff]);

  // 5. Delete reply tokens older than 1 hour
  const tokenCutoff = addMs(now, -HOUR_MS);
  const deletedTokens = await ctx.db.query(`delete from reply_tokens where issued_at < $1`, [tokenCutoff]);

  // 6. Delete relay attempts log older than 90 days
  const deletedAttempts = await ctx.db.query(`delete from relay_attempts where started_at < $1`, [mapCutoff]);

  // 7. Delete inactive user profiles (last seen > 180 days)
  const userCutoff = addMs(now, -cfg.RETENTION_PROFILE_DAYS * DAY_MS);
  const deletedUsers = await ctx.db.query(
    `delete from line_users where last_seen_at < $1 and not exists (select 1 from bridge_admins where user_id = line_users.user_id)`,
    [userCutoff],
  );

  // 8. Delete expired link codes
  const deletedCodes = await ctx.db.query(`delete from link_codes where expires_at < $1`, [now]);

  // 9. Clean up temporary flood notices from system_state
  await ctx.db.query(`delete from system_state where key like 'flood_notice:%' and updated_at < $1`, [tokenCutoff]);

  const result: PurgeResult = {
    scrubbedPayloads: scrubbed.rowCount,
    purgedMessages: purgedMsgs.rowCount,
    deletedMedia,
    deletedCopies: deletedCopies.rowCount,
    deletedTokens: deletedTokens.rowCount,
    deletedAttempts: deletedAttempts.rowCount,
    deletedUsers: deletedUsers.rowCount,
    deletedLinkCodes: deletedCodes.rowCount,
  };

  ctx.log.info({ purge: result }, 'retention purge completed');
  return result;
}
