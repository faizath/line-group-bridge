import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { loadConfig } from '../../src/config.js';
import { registerGroup } from '../../src/core/groups.js';
import type { BridgeRow } from '../../src/core/rows.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import { localDay, monthToDate, recordUsage } from '../../src/cost/usage.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import { createLogger } from '../../src/logger.js';
import { ManualClock } from '../../src/util/clock.js';
import { uuid } from '../../src/util/ids.js';

describe('Cost and QuotaGuard (FR-COST, [06])', () => {
  let db: Db;
  let clock: ManualClock;
  let ctx: AppContext;
  let quota: QuotaGuard;
  let bridgeId: string;

  let mockQuotaValue: number | null = 100_000;
  let mockConsumption = 10_000;

  const lineStub: Partial<LinePlatform> = {
    async getQuota() {
      return mockQuotaValue !== null ? { type: 'limited', value: mockQuotaValue } : { type: 'none' };
    },
    async getQuotaConsumption() {
      return { totalUsage: mockConsumption };
    },
  };

  beforeAll(async () => {
    db = await openDb('pglite://memory');
    await migrate(db);
    clock = new ManualClock(Date.parse('2026-09-15T12:00:00Z'));

    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      LINE_CHANNEL_SECRET: 'sec',
      LINE_ACCESS_TOKEN: 'tok',
      MEDIA_BACKEND: 'fs',
      MEDIA_FS_ROOT: '/tmp',
      MEDIA_PUBLIC_BASE_URL: 'https://media.example',
      QUOTA_ALERT_PCT: '80',
      QUOTA_HARD_PCT: '95',
      QUOTA_TZ: 'Asia/Tokyo',
    });

    ctx = {
      config,
      db,
      clock,
      log: createLogger('silent'),
      line: lineStub as LinePlatform,
      media: {} as unknown as import('../../src/media/types.js').MediaService,
      store: {} as unknown as import('../../src/media/types.js').MediaStore,
      stickers: {} as unknown as import('../../src/translate/stickers.js').StickerPolicy,
      metrics: new (await import('../../src/metrics.js')).Metrics(),
      tokens: null,
      instanceId: 'cost-inst',
      bot: { userId: 'Ubot' },
    };

    quota = new QuotaGuard(ctx);

    bridgeId = uuid();
    await db.query(
      `insert into bridges (id, channel_id, name, delivery_mode) values ($1, 'ch', 'Cost Bridge', 'immediate')`,
      [bridgeId],
    );
    await registerGroup(db, ctx, 'G-C1', clock.now());
    await registerGroup(db, ctx, 'G-C2', clock.now());
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'A', member_count = 100 where group_id = 'G-C1'`,
      [bridgeId],
    );
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'B', member_count = 200 where group_id = 'G-C2'`,
      [bridgeId],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  describe('usage accounting (usage.ts)', () => {
    it('computes local day and month in target timezone', () => {
      const d = localDay(new Date('2026-09-15T23:30:00Z'), 'Asia/Tokyo');
      // 23:30 UTC on Sep 15 is 08:30 JST on Sep 16
      expect(d.day).toBe('2026-09-16');
      expect(d.month).toBe('2026-09');
      expect(d.monthStart).toBe('2026-09-01');
      expect(d.dayOfMonth).toBe(16);
      expect(d.daysInMonth).toBe(30);
    });

    it('records and aggregates daily usage deltas', async () => {
      const day = localDay(clock.now(), 'Asia/Tokyo');
      await recordUsage(db, bridgeId, day.day, { pushes: 5, replies: 3, billed: 750, relayed: 5 });
      await recordUsage(db, bridgeId, day.day, { pushes: 2, billed: 300, relayed: 2 });

      const mtd = await monthToDate(db, bridgeId, day);
      expect(mtd.pushes).toBe(7);
      expect(mtd.replies).toBe(3);
      expect(mtd.billed).toBe(1050);
      expect(mtd.relayed).toBe(7);
    });
  });

  describe('quota guard (quotaGuard.ts)', () => {
    it('polls quota and consumption, updating gauges and status', async () => {
      mockQuotaValue = 100_000;
      mockConsumption = 20_000;

      const st = await quota.poll();
      expect(st.limit).toBe(100_000);
      expect(st.used).toBe(20_000);
      expect(st.stopped).toBe(false);

      const status = await quota.status();
      expect(status.limit).toBe(100_000);
      expect(status.used).toBe(20_000);
    });

    it('flips active bridges to strict economy when hard threshold (95%) is reached', async () => {
      mockQuotaValue = 100_000;
      mockConsumption = 96_000; // >= 95%

      await quota.poll();

      const { rows } = await db.query<BridgeRow>('select * from bridges where id = $1', [bridgeId]);
      expect(rows[0]?.delivery_mode).toBe('strict_economy');
      expect(rows[0]?.forced_mode_reason).toBe('quota_hard');
      expect(rows[0]?.mode_before_force).toBe('immediate');
    });

    it('resumes pushes and restores original delivery modes', async () => {
      await quota.resume('operator');

      const { rows } = await db.query<BridgeRow>('select * from bridges where id = $1', [bridgeId]);
      expect(rows[0]?.delivery_mode).toBe('immediate');
      expect(rows[0]?.forced_mode_reason).toBeNull();
      expect(rows[0]?.mode_before_force).toBeNull();
    });

    it('stops pushes and forces strict economy on monthly limit 429', async () => {
      await quota.onMonthlyLimit();

      const bridge = (await db.query<BridgeRow>('select * from bridges where id = $1', [bridgeId])).rows[0]!;
      expect(bridge.delivery_mode).toBe('strict_economy');
      expect(bridge.forced_mode_reason).toBe('monthly_limit');

      const allowed = await quota.canPush(bridge);
      expect(allowed).toBe(false);

      // Resume
      await quota.resume('operator');
      expect(await quota.canPush(bridge)).toBe(true);
    });

    it('enforces optional per-bridge monthly budget', async () => {
      // Set budget of 500 messages (current MTD billed is 1050)
      await db.query(`update bridges set monthly_budget = 500 where id = $1`, [bridgeId]);
      const bridge = (await db.query<BridgeRow>('select * from bridges where id = $1', [bridgeId])).rows[0]!;

      const allowed = await quota.canPush(bridge);
      expect(allowed).toBe(false);

      const updated = (await db.query<BridgeRow>('select * from bridges where id = $1', [bridgeId])).rows[0]!;
      expect(updated.delivery_mode).toBe('strict_economy');
      expect(updated.forced_mode_reason).toBe('budget');

      // Clear budget
      await db.query(`update bridges set monthly_budget = null, delivery_mode = 'immediate', forced_mode_reason = null where id = $1`, [bridgeId]);
    });

    it('computes projected monthly immediate cost estimate based on recent traffic', async () => {
      // Insert traffic for G-C1 (100 members) and G-C2 (200 members), total M = 300
      // 10 messages in G-C1 -> cost per msg = 300 - 100 = 200 -> weekly 2,000
      for (let i = 0; i < 10; i++) {
        await db.query(
          `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts, relayed)
           values ($1, $2, 'G-C1', 'text', $3, true)`,
          [uuid(), bridgeId, clock.now()],
        );
      }

      const estimate = await quota.immediateMonthlyEstimate(bridgeId);
      expect(estimate).toBeGreaterThan(0);
      // Weekly = 2000, 30 days = 2000 * 30 / 7 ≈ 8571
      expect(estimate).toBeCloseTo(8571, -2);
    });
  });
});
