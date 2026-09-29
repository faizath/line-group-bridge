import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashAdminToken } from '../../src/admin/auth.js';
import { buildAdminApp } from '../../src/app/app.js';
import type { AppContext } from '../../src/app/context.js';
import { loadConfig } from '../../src/config.js';
import { registerGroup } from '../../src/core/groups.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import { createLogger } from '../../src/logger.js';
import { FsMediaStore } from '../../src/media/store.js';
import type { MediaService } from '../../src/media/types.js';
import { Metrics } from '../../src/metrics.js';
import { StickerPolicy } from '../../src/translate/stickers.js';
import { ManualClock } from '../../src/util/clock.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

describe('Admin HTTP API', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let quota: QuotaGuard;
  let ctx: AppContext;
  let app: FastifyInstance;
  const token = 'secret-admin-token-123';

  const lineStub: Partial<LinePlatform> = {
    async leaveGroup() {},
    async getQuota() {
      return { type: 'limited', value: 50000 };
    },
    async getQuotaConsumption() {
      return { totalUsage: 1200 };
    },
    async getBotInfo() {
      return { userId: 'Ubot', displayName: 'Bridge Bot' };
    },
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-admin-test-'));
    db = await openDb('pglite://memory');
    await migrate(db);
    clock = new ManualClock();

    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      LINE_CHANNEL_SECRET: 'sec',
      LINE_ACCESS_TOKEN: 'tok',
      MEDIA_BACKEND: 'fs',
      MEDIA_FS_ROOT: tmpDir,
      MEDIA_PUBLIC_BASE_URL: 'https://media.example',
      ADMIN_API_TOKENS: hashAdminToken(token),
    });

    const store = new FsMediaStore(tmpDir);
    ctx = {
      config,
      db,
      clock,
      log: createLogger('silent'),
      line: lineStub as LinePlatform,
      media: {
        defaultIconUrl: async () => 'https://media.example/default.png',
        publicUrl: (k: string) => `https://media.example/${k}`,
        purgeMessage: async () => {},
      } as unknown as MediaService,
      store,
      stickers: new StickerPolicy(),
      metrics: new Metrics(),
      tokens: null,
      instanceId: 'test-admin-inst',
      bot: { userId: 'Ubot' },
    };

    quota = new QuotaGuard(ctx);
    app = buildAdminApp(ctx, quota);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const authHeader = { Authorization: `Bearer ${token}` };

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/v1/bridges' });
    expect(res.statusCode).toBe(401);
  });

  it('creates and lists bridges', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/v1/bridges',
      headers: authHeader,
      payload: { name: 'Admin Bridge', deliveryMode: 'economy' },
    });
    expect(createRes.statusCode).toBe(201);
    const body = createRes.json() as { bridge: { id: string; name: string } };
    expect(body.bridge.name).toBe('Admin Bridge');

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/v1/bridges',
      headers: authHeader,
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as { bridges: Array<{ name: string }> };
    expect(listBody.bridges.some((b) => b.name === 'Admin Bridge')).toBe(true);
  });

  it('attaches and detaches groups to a bridge', async () => {
    // 1. Create bridge
    const bRes = await app.inject({
      method: 'POST',
      url: '/admin/v1/bridges',
      headers: authHeader,
      payload: { name: 'Attach Test' },
    });
    const bridgeId = (bRes.json() as { bridge: { id: string } }).bridge.id;

    // 2. Register group
    await registerGroup(db, ctx, 'G-Admin-1', clock.now());

    // 3. Attach group
    const attachRes = await app.inject({
      method: 'POST',
      url: `/admin/v1/bridges/${bridgeId}/groups/G-Admin-1`,
      headers: authHeader,
    });
    expect(attachRes.statusCode).toBe(200);
    const attachedGroup = (attachRes.json() as { group: { state: string; short_tag: string } }).group;
    expect(attachedGroup.state).toBe('attached');
    expect(attachedGroup.short_tag).toBe('A');

    // 4. Detach group
    const detachRes = await app.inject({
      method: 'DELETE',
      url: `/admin/v1/bridges/${bridgeId}/groups/G-Admin-1`,
      headers: authHeader,
    });
    expect(detachRes.statusCode).toBe(200);
  });

  it('exposes usage and quota information', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/v1/usage',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { month: string; usageMonthToDate: unknown; quota: unknown };
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('exports and erases user data (GDPR/APPI)', async () => {
    // Insert user and message
    const bId = '00000000-0000-0000-0000-000000000001';
    await db.query(`insert into bridges (id, channel_id, name, delivery_mode) values ($1, 'ch', 'B', 'batched') on conflict do nothing`, [bId]);
    await db.query(`insert into line_users (user_id, display_name) values ('Ugdpr', 'Gdpr User')`);
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, user_id, type, event_ts, text)
       values ('m-gdpr-1', '00000000-0000-0000-0000-000000000001', 'G1', 'Ugdpr', 'text', $1, 'secret info')`,
      [clock.now()],
    );

    // Export
    const expRes = await app.inject({
      method: 'GET',
      url: '/admin/v1/users/Ugdpr',
      headers: authHeader,
    });
    expect(expRes.statusCode).toBe(200);
    const expData = expRes.json() as { user: { display_name: string }; messageCount: number };
    expect(expData.user.display_name).toBe('Gdpr User');
    expect(expData.messageCount).toBe(1);

    // Erase
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/admin/v1/users/Ugdpr/data',
      headers: authHeader,
    });
    expect(delRes.statusCode).toBe(200);

    // Verify user profile is deleted and message text is nulled out
    const { rows: u } = await db.query('select * from line_users where user_id = $1', ['Ugdpr']);
    expect(u).toHaveLength(0);

    const { rows: m } = await db.query('select * from origin_messages where message_id = $1', ['m-gdpr-1']);
    expect(m[0]?.text).toBeNull();
    expect(m[0]?.user_id).toBeNull();
  });
});
