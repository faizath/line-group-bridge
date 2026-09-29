import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { loadConfig } from '../../src/config.js';
import { registerGroup } from '../../src/core/groups.js';
import { insertJobs } from '../../src/core/jobs.js';
import { registerToken } from '../../src/core/replyTokens.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import { Lanes } from '../../src/delivery/lanes.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { LinePlatform, PushOptions } from '../../src/line/adapter.js';
import { LineApiError } from '../../src/line/adapter.js';
import type { OutboundMessage } from '../../src/line/types.js';
import { createLogger } from '../../src/logger.js';
import { FsMediaStore } from '../../src/media/store.js';
import type { MediaService } from '../../src/media/types.js';
import { Metrics } from '../../src/metrics.js';
import { StickerPolicy } from '../../src/translate/stickers.js';
import { ManualClock } from '../../src/util/clock.js';
import { uuid } from '../../src/util/ids.js';

describe('Lanes delivery engine', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let quota: QuotaGuard;
  let lanes: Lanes;
  let ctx: AppContext;
  let bridgeId: string;

  const pushes: Array<{ to: string; messages: OutboundMessage[]; opts: PushOptions }> = [];
  const replies: Array<{ token: string; messages: OutboundMessage[] }> = [];
  let injectPushError: Error | null = null;
  let inject409 = false;

  const lineStub: Partial<LinePlatform> = {
    async push(to, messages, opts) {
      if (injectPushError) throw injectPushError;
      pushes.push({ to, messages, opts });
      if (inject409) {
        return {
          status: 409,
          sentMessages: [{ id: 'sent-409', quoteToken: 'qt-409' }],
          acceptedRequestId: 'orig-req-1',
          requestId: 'req-409',
        };
      }
      return {
        status: 200,
        sentMessages: [{ id: `sent-${Date.now()}`, quoteToken: 'qt-ok' }],
        requestId: 'req-ok',
      };
    },
    async reply(token, messages) {
      replies.push({ token, messages });
      return { status: 200, sentMessages: [{ id: `reply-sent-${Date.now()}` }], requestId: 'req-rep' };
    },
    async getGroupMemberCount() {
      return 120;
    },
    async getGroupSummary(id) {
      return { groupId: id, groupName: `Group ${id}` };
    },
    async getGroupMemberProfile(_gid, uid) {
      return { userId: uid, displayName: `User ${uid}` };
    },
    async getQuota() {
      return { type: 'limited', value: 100000 };
    },
    async getQuotaConsumption() {
      return { totalUsage: 500 };
    },
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-lane-test-'));
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
        refs: async () => null,
      } as unknown as MediaService,
      store,
      stickers: new StickerPolicy(),
      metrics: new Metrics(),
      tokens: null,
      instanceId: 'test-lane-inst',
      bot: { userId: 'Ubot' },
    };

    quota = new QuotaGuard(ctx);
    lanes = new Lanes(ctx, quota);

    bridgeId = uuid();
    await db.query(
      `insert into bridges (id, channel_id, name, delivery_mode) values ($1, 'ch', 'Bridge Lanes', 'immediate')`,
      [bridgeId],
    );
    await registerGroup(db, ctx, 'G-T1', clock.now());
    await registerGroup(db, ctx, 'G-T2', clock.now());
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'A', member_count = 120 where group_id = 'G-T1'`,
      [bridgeId],
    );
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'B', member_count = 150 where group_id = 'G-T2'`,
      [bridgeId],
    );
  });

  afterAll(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pushes.length = 0;
    replies.length = 0;
    injectPushError = null;
    inject409 = false;
    await db.query('delete from relay_copies');
    await db.query('delete from relay_jobs');
    await db.query('delete from outbound_requests');
    await db.query('delete from origin_messages');
  });

  async function createOriginAndJob(originId: string, text: string, target = 'G-T2'): Promise<string> {
    const now = clock.now();
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, user_id, type, event_ts, text)
       values ($1, $2, 'G-T1', 'Ualice', 'text', $3, $4)
       on conflict (message_id) do nothing`,
      [originId, bridgeId, now, text],
    );

    const jobId = uuid();
    await insertJobs(db, [
      {
        bridgeId,
        originMessageId: originId,
        originGroupId: 'G-T1',
        targetGroupId: target,
        kind: 'relay',
        state: 'queued',
        orderTs: now,
        readyAt: now,
      },
    ]);
    return jobId;
  }

  it('delivers queued job via push in immediate mode with retry key', async () => {
    await createOriginAndJob('msg-lane-1', 'hello immediate push');

    const outcome = await lanes.processLane('G-T2');
    expect(outcome).toBe('sent');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.to).toBe('G-T2');
    expect(pushes[0]?.messages[0]?.type).toBe('text');
    expect(pushes[0]?.opts.retryKey).toBeDefined();

    // Verify relay_copies populated
    const { rows: copies } = await db.query('select * from relay_copies where origin_message_id = $1', ['msg-lane-1']);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.target_group_id).toBe('G-T2');

    // Verify usage recorded (billed estimate = 150 target members)
    const { rows: usage } = await db.query('select * from usage_daily where bridge_id = $1', [bridgeId]);
    expect(usage[0]?.pushes).toBe(1);
    expect(usage[0]?.billed_estimate).toBe(150);
  });

  it('handles 409 duplicate response gracefully without error', async () => {
    await createOriginAndJob('msg-lane-2', 'duplicate test');
    inject409 = true;

    const outcome = await lanes.processLane('G-T2');
    expect(outcome).toBe('sent');

    // Verify job marked delivered with the 409 sentMessages
    const { rows: jobs } = await db.query('select * from relay_jobs where origin_message_id = $1', ['msg-lane-2']);
    expect(jobs[0]?.state).toBe('delivered');

    const { rows: copies } = await db.query('select * from relay_copies where origin_message_id = $1', ['msg-lane-2']);
    expect(copies[0]?.sent_message_id).toBe('sent-409');
  });

  it('piggybacks on available reply token to deliver for free via reply', async () => {
    await createOriginAndJob('msg-lane-3', 'reply piggyback test');

    // Offer a fresh reply token for G-T2
    await registerToken(db, 'tok-free-piggyback', 'G-T2', 'ev-piggy', clock.now());

    const outcome = await lanes.processLane('G-T2');
    expect(outcome).toBe('sent');

    // Delivered via reply, NOT push!
    expect(replies).toHaveLength(1);
    expect(replies[0]?.token).toBe('tok-free-piggyback');
    expect(pushes).toHaveLength(0);

    const { rows: jobs } = await db.query('select * from relay_jobs where origin_message_id = $1', ['msg-lane-3']);
    expect(jobs[0]?.delivered_via).toBe('reply');
  });

  it('retries on 5xx error with backoff and keeps request in pending', async () => {
    await createOriginAndJob('msg-lane-4', '5xx retry test');
    injectPushError = new LineApiError('Service unavailable', 503, '/v2/bot/message/push');

    const outcome = await lanes.processLane('G-T2');
    expect(outcome).toBe('sent'); // A send was attempted

    // Outbound request should be in pending state for retry
    const { rows: requests } = await db.query(
      `select * from outbound_requests where target_group_id = 'G-T2' and state = 'pending'`,
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.attempts).toBe(1);
    expect(requests[0]?.last_error).toContain('503 Service unavailable');
  });

  it('runs fallback ladder on 400 error', async () => {
    await createOriginAndJob('msg-lane-5', '400 fallback test');
    injectPushError = new LineApiError('Bad request', 400, '/v2/bot/message/push');

    await lanes.processLane('G-T2');

    // Job climbs the fallback ladder to step 4 and exhausts into dead-letter
    const { rows: jobs } = await db.query('select * from relay_jobs where origin_message_id = $1', ['msg-lane-5']);
    expect(jobs[0]?.fallback_step).toBe(4);
    expect(jobs[0]?.state).toBe('dead');
  });
});
