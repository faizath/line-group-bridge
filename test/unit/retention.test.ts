import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import type { MediaService, MediaStore } from '../../src/media/types.js';
import type { Metrics } from '../../src/metrics.js';
import { runRetentionPurge } from '../../src/retention/purge.js';
import type { StickerPolicy } from '../../src/translate/stickers.js';
import { createLogger } from '../../src/logger.js';
import { ManualClock } from '../../src/util/clock.js';
import { uuid } from '../../src/util/ids.js';

describe('Retention purge', () => {
  let db: Db;
  let clock: ManualClock;
  let ctx: AppContext;
  let bridgeId: string;

  beforeAll(async () => {
    db = await openDb('pglite://memory');
    await migrate(db);
    clock = new ManualClock(Date.parse('2026-10-01T00:00:00Z'));

    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      LINE_CHANNEL_SECRET: 'sec',
      LINE_ACCESS_TOKEN: 'tok',
      MEDIA_BACKEND: 'fs',
      MEDIA_FS_ROOT: '/tmp',
      MEDIA_PUBLIC_BASE_URL: 'https://media.example',
      RETENTION_TEXT_DAYS: '30',
      RETENTION_PAYLOAD_DAYS: '7',
      RETENTION_MAP_DAYS: '90',
      RETENTION_PROFILE_DAYS: '180',
    });

    ctx = {
      config,
      db,
      clock,
      log: createLogger('silent'),
      line: {} as unknown as LinePlatform,
      media: {
        purgeExpired: async () => 2,
      } as unknown as MediaService,
      store: {} as unknown as MediaStore,
      stickers: {} as unknown as StickerPolicy,
      metrics: {} as unknown as Metrics,
      tokens: null,
      instanceId: 'test-ret',
      bot: { userId: 'Ubot' },
    };

    bridgeId = uuid();
    await db.query(
      `insert into bridges (id, channel_id, name, delivery_mode) values ($1, 'ch', 'Bridge Ret', 'batched')`,
      [bridgeId],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('nulls out message text from old origin messages (30 days) and old payloads (7 days)', async () => {
    const now = clock.now();
    const old35Days = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
    const old10Days = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fresh2Days = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    // 1. Origin messages: one 35 days old, one 2 days old
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts, text, meta)
       values ('m-old-35', $1, 'G1', 'text', $2, 'old sensitive text', '{"emojis":[]}'::jsonb)`,
      [bridgeId, old35Days],
    );
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts, text, meta)
       values ('m-fresh-2', $1, 'G1', 'text', $2, 'fresh text', '{"emojis":[]}'::jsonb)`,
      [bridgeId, fresh2Days],
    );

    // 2. Inbound event payloads: one 10 days old, one 2 days old
    await db.query(
      `insert into inbound_events (webhook_event_id, channel_id, type, group_id, event_ts, received_at, is_redelivery, payload)
       values ('ev-old-10', 'ch', 'message', 'G1', $1, $1, false, '{"message":{"id":"1","text":"old payload text"}}'::jsonb)`,
      [old10Days],
    );
    await db.query(
      `insert into inbound_events (webhook_event_id, channel_id, type, group_id, event_ts, received_at, is_redelivery, payload)
       values ('ev-fresh-2', 'ch', 'message', 'G1', $1, $1, false, '{"message":{"id":"2","text":"fresh payload text"}}'::jsonb)`,
      [fresh2Days],
    );

    // 3. Expired link code
    await db.query(
      `insert into link_codes (code, bridge_id, created_by, expires_at) values ('EXPD-CODE', $1, 'Ualice', $2)`,
      [bridgeId, old10Days],
    );

    // Run purge
    const result = await runRetentionPurge(ctx, now);
    expect(result.purgedMessages).toBe(1);
    expect(result.scrubbedPayloads).toBe(1);
    expect(result.deletedLinkCodes).toBe(1);

    // Verify old origin message text is nulled
    const { rows: oldM } = await db.query('select text, meta, purged_at from origin_messages where message_id = $1', ['m-old-35']);
    expect(oldM[0]?.text).toBeNull();
    expect(oldM[0]?.meta).toBeNull();
    expect(oldM[0]?.purged_at).not.toBeNull();

    // Verify fresh origin message text is kept
    const { rows: freshM } = await db.query('select text from origin_messages where message_id = $1', ['m-fresh-2']);
    expect(freshM[0]?.text).toBe('fresh text');

    // Verify old payload text is scrubbed
    const { rows: oldEv } = await db.query<{ payload: { message: { text: string | null } } }>(
      'select payload from inbound_events where webhook_event_id = $1',
      ['ev-old-10'],
    );
    expect(oldEv[0]?.payload.message.text).toBeNull();

    // Verify fresh payload text is kept
    const { rows: freshEv } = await db.query<{ payload: { message: { text: string | null } } }>(
      'select payload from inbound_events where webhook_event_id = $1',
      ['ev-fresh-2'],
    );
    expect(freshEv[0]?.payload.message.text).toBe('fresh payload text');
  });
});
