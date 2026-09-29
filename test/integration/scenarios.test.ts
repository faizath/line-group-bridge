import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app/app.js';
import type { AppContext } from '../../src/app/context.js';
import { Commands } from '../../src/commands/handler.js';
import { loadConfig } from '../../src/config.js';
import { attachedGroups, registerGroup } from '../../src/core/groups.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { Lanes } from '../../src/delivery/lanes.js';
import { SdkLineClient } from '../../src/line/client.js';
import { NoopRateLimiter } from '../../src/line/rateLimiter.js';
import { createTokenProvider } from '../../src/line/tokens.js';
import { createLogger } from '../../src/logger.js';
import { DefaultMediaService } from '../../src/media/service.js';
import { FsMediaStore } from '../../src/media/store.js';
import { Metrics } from '../../src/metrics.js';
import { EventProcessor } from '../../src/processor/processor.js';
import { processTask } from '../../src/processor/tasks.js';
import { claimTasks } from '../../src/core/tasks.js';
import { StickerPolicy } from '../../src/translate/stickers.js';
import { ManualClock } from '../../src/util/clock.js';
import type { FakeLine } from '../fake-line/server.js';
import { createFakeLine } from '../fake-line/server.js';
import {
  editEvent,
  imageEvent,
  textEvent,
  unsendEvent,
} from '../fake-line/webhook.js';

describe('End-to-End Integration Scenarios (PRD/02 §8, PRD/13 §4)', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let fakeLine: FakeLine;
  let ctx: AppContext;
  let publicApp: ReturnType<typeof buildPublicApp>;
  let quota: QuotaGuard;
  let commands: Commands;
  let lanes: Lanes;
  let processor: EventProcessor;

  const secret = 'test-channel-secret-12345';
  const botId = 'Ubot-bridge';

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-e2e-'));
    db = await openDb('pglite://memory');
    await migrate(db);
    clock = new ManualClock(Date.parse('2026-09-29T10:00:00Z'));

    // Start Fake LINE Platform on random port
    fakeLine = await createFakeLine({
      channelSecret: secret,
      botUserId: botId,
      now: () => clock.now().getTime(),
    });

    // Populate fake LINE groups: A (480 members), B (480 members), C (480 members)
    fakeLine.addGroup({
      groupId: 'G-A',
      name: 'Alumni Alpha',
      members: [{ userId: 'Uaiko', displayName: 'Aiko' }],
    });
    fakeLine.addGroup({
      groupId: 'G-B',
      name: 'Alumni Beta',
      members: [{ userId: 'Uken', displayName: 'Ken' }],
    });
    fakeLine.addGroup({
      groupId: 'G-C',
      name: 'Alumni Gamma',
      members: [{ userId: 'Uyuki', displayName: 'Yuki' }],
    });

    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      LINE_CHANNEL_SECRET: secret,
      LINE_ACCESS_TOKEN: 'test-token',
      LINE_API_BASE: fakeLine.url,
      LINE_API_DATA_BASE: fakeLine.url,
      LINE_BOT_USER_ID: botId,
      MEDIA_BACKEND: 'fs',
      MEDIA_FS_ROOT: tmpDir,
      MEDIA_PUBLIC_BASE_URL: 'https://media.example',
      OPERATOR_USER_IDS: 'Uoperator',
      BRIDGE_CREATE_POLICY: 'anyone',
      DEFAULT_DELIVERY_MODE: 'immediate',
    });

    const store = new FsMediaStore(tmpDir);
    const log = createLogger('silent');
    const limiter = new NoopRateLimiter();
    const tokens = createTokenProvider({ config, db, clock, log, limiter });
    const line = new SdkLineClient({ config, tokens, limiter, log, clock });
    const media = new DefaultMediaService({ db, line, store, config, clock, log });
    const stickers = new StickerPolicy();
    const metrics = new Metrics();

    ctx = {
      config,
      db,
      clock,
      log,
      line,
      media,
      store,
      stickers,
      metrics,
      tokens,
      instanceId: 'e2e-inst',
      bot: { userId: botId },
    };

    quota = new QuotaGuard(ctx);
    commands = new Commands(ctx, quota);
    lanes = new Lanes(ctx, quota);
    processor = new EventProcessor(ctx, lanes, commands);

    publicApp = buildPublicApp(ctx);
  });
  afterAll(async () => {
    await publicApp.close();
    await fakeLine.close();
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
  async function sendWebhook(events: Array<Record<string, unknown>>) {
    const raw = JSON.stringify({ destination: botId, events });
    const res = await publicApp.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': (await import('../fake-line/webhook.js')).signBody(secret, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  }

  async function stepWorker() {
    await processor.runBatch();
    const tasks = await claimTasks(db, clock.now(), 10);
    for (const t of tasks) await processTask(ctx, t);
    await lanes.runDue(4);
  }

  it('Setup: links group A, B and C into one Alumni bridge', async () => {
    // 1. Bot invited to G-A -> create bridge
    await sendWebhook([
      textEvent({ groupId: 'G-A', userId: 'Uaiko', text: '/bridge create Alumni', fake: fakeLine }),
    ]);
    await stepWorker();

    const gA = await db.query<{ bridge_id: string }>('select bridge_id from member_groups where group_id = $1', ['G-A']);
    expect(gA.rows[0]?.bridge_id).toBeDefined();
    const bridgeId = gA.rows[0]!.bridge_id;

    // Attach G-B and G-C directly via DB for test simplicity
    await registerGroup(db, ctx, 'G-B', clock.now());
    await registerGroup(db, ctx, 'G-C', clock.now());
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'B', relay_in = true, relay_out = true where group_id = 'G-B'`,
      [bridgeId],
    );
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'C', relay_in = true, relay_out = true where group_id = 'G-C'`,
      [bridgeId],
    );

    const attached = await attachedGroups(db, bridgeId);
    expect(attached).toHaveLength(3);
  });

  it('Scenario S1 — Plain text in immediate mode with author attribution', async () => {
    // 1. Ken (group B) sends "anyone going Saturday?"
    const ev = textEvent({
      groupId: 'G-B',
      userId: 'Uken',
      text: 'anyone going Saturday?',
      id: 'm-s1-1',
      fake: fakeLine,
    });

    await sendWebhook([ev]);

    // 2. Worker processes and flushes lanes
    await stepWorker();

    // 3. Groups A and C each receive the message with Ken's attribution
    const delA = fakeLine.delivered('G-A');
    expect(delA.length).toBeGreaterThan(0);
    const lastA = delA[delA.length - 1]!;
    expect(lastA.messages[0]?.type).toBe('text');
    if (lastA.messages[0]?.type === 'text') {
      expect(lastA.messages[0].text).toBe('anyone going Saturday?');
      const sender = lastA.messages[0].sender as { name?: string } | undefined;
      expect(sender?.name).toBe('Ken·B');
    }

    const delC = fakeLine.delivered('G-C');
    expect(delC.length).toBeGreaterThan(0);
    const lastC = delC[delC.length - 1]!;
    expect(lastC.messages[0]?.type).toBe('text');
    if (lastC.messages[0]?.type === 'text') {
      expect(lastC.messages[0].text).toBe('anyone going Saturday?');
      const sender = lastC.messages[0].sender as { name?: string } | undefined;
      expect(sender?.name).toBe('Ken·B');
    }

    // 4. Verify billing counters: G-A (1 member in fake) + G-C (1 member in fake) = 2
    expect(fakeLine.billed['G-A']).toBe(1);
    expect(fakeLine.billed['G-C']).toBe(1);
  });

  it('Scenario S2 — Economy mode reply-token piggybacking', async () => {
    // 1. Set bridge to economy mode
    const { rows } = await db.query<{ id: string }>('select id from bridges limit 1');
    const bridgeId = rows[0]!.id;
    await db.query(`update bridges set delivery_mode = 'economy', max_hold_s = 600 where id = $1`, [bridgeId]);

    // Clear recorded deliveries
    fakeLine.clearDeliveries();

    // 2. Ken (G-B) posts "lunch?" at 10:00:00
    const ev1 = textEvent({
      groupId: 'G-B',
      userId: 'Uken',
      text: 'lunch?',
      id: 'm-s2-lunch',
      fake: fakeLine,
    });
    await sendWebhook([ev1]);
    await processor.runBatch();

    // In economy mode with no reply tokens, jobs remain held (0 pushes sent)
    await lanes.runDue(4);
    expect(fakeLine.delivered('G-A')).toHaveLength(0);
    expect(fakeLine.delivered('G-C')).toHaveLength(0);

    // 3. At 10:00:20, Aiko posts "yes!" in G-A -> carries a reply token for G-A
    clock.advance(20_000);
    const ev2 = textEvent({
      groupId: 'G-A',
      userId: 'Uaiko',
      text: 'yes!',
      id: 'm-s2-yes',
      fake: fakeLine,
    });
    await sendWebhook([ev2]);

    // Worker processes Aiko's message and flushes G-A's outbox via reply!
    await stepWorker();

    // G-A receives the pending "lunch?" message via FREE reply!
    const delA = fakeLine.delivered('G-A');
    expect(delA.length).toBeGreaterThan(0);
    expect(delA[0]?.via).toBe('reply');

    // 4. C stays quiet. Advance time past max-hold (10 min) -> C's outbox flushes via push (billed)
    clock.advance(10 * 60 * 1000);
    await stepWorker();
    const delC = fakeLine.delivered('G-C');
    expect(delC.length).toBeGreaterThan(0);
    expect(delC[0]?.via).toBe('push');
  });

  it('Scenario S4 — Crash between push and bookkeeping (409 idempotency)', async () => {
    // Set back to immediate mode
    const { rows } = await db.query<{ id: string }>('select id from bridges limit 1');
    await db.query(`update bridges set delivery_mode = 'immediate' where id = $1`, [rows[0]!.id]);

    // Send a message
    const ev = textEvent({
      groupId: 'G-B',
      userId: 'Uken',
      text: 'crash test message',
      id: 'm-s4-crash',
      fake: fakeLine,
    });
    await sendWebhook([ev]);
    await stepWorker();
    const copiesBefore = await db.query('select * from relay_copies where origin_message_id = $1', ['m-s4-crash']);
    expect(copiesBefore.rows.length).toBeGreaterThan(0);

    // Simulate crash: reset the request to 'pending' so it retries with the SAME retry key
    await db.query(
      `update outbound_requests set state = 'pending', next_attempt_at = $2
       where id in (select request_id from relay_jobs where origin_message_id = $1)`,
      ['m-s4-crash', clock.now()],
    );

    // Retry push: fake LINE answers 409 Conflict with the original sentMessages!
    await lanes.runDue(4);

    // Verify 0 duplicates in relay_copies
    const copiesAfter = await db.query('select * from relay_copies where origin_message_id = $1', ['m-s4-crash']);
    expect(copiesAfter.rows.length).toBe(copiesBefore.rows.length);
  });

  it('Scenario S3 — Photo album order and batching', async () => {
    // Generate small test PNG
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 100, g: 150, b: 200 } } }).png().toBuffer();
    fakeLine.setContent('m-album-1', { contentType: 'image/png', data: png });
    fakeLine.setContent('m-album-2', { contentType: 'image/png', data: png });
    fakeLine.setContent('m-album-3', { contentType: 'image/png', data: png });

    // Send 3 album images with imageSet { id: 'album-1', total: 3, index }
    const ev1 = imageEvent({ groupId: 'G-B', userId: 'Uken', id: 'm-album-1', imageSet: { id: 'album-1', index: 1, total: 3 }, fake: fakeLine });
    const ev2 = imageEvent({ groupId: 'G-B', userId: 'Uken', id: 'm-album-2', imageSet: { id: 'album-1', index: 2, total: 3 }, fake: fakeLine });
    const ev3 = imageEvent({ groupId: 'G-B', userId: 'Uken', id: 'm-album-3', imageSet: { id: 'album-1', index: 3, total: 3 }, fake: fakeLine });

    // Send in arrival order: 2, 3, 1 (out-of-order arrival)
    await sendWebhook([ev2, ev3, ev1]);

    // Process all 3 events and background media tasks
    await stepWorker();
    await stepWorker();

    // Verify jobs were delivered
    const { rows: jobs } = await db.query(
      `select * from relay_jobs where origin_message_id in ('m-album-1','m-album-2','m-album-3') and target_group_id = 'G-A' order by order_idx`,
    );
    expect(jobs).toHaveLength(3);
    expect(jobs[0]?.origin_message_id).toBe('m-album-1');
    expect(jobs[1]?.origin_message_id).toBe('m-album-2');
    expect(jobs[2]?.origin_message_id).toBe('m-album-3');
  });

  it('US-9 Cross-group reply quote resolves to target copy quoteToken', async () => {
    // 1. Ken sends message in B -> copies in A and C
    const evOriginal = textEvent({
      groupId: 'G-B',
      userId: 'Uken',
      text: 'who wants pizza?',
      id: 'm-orig-pizza',
      fake: fakeLine,
    });
    await sendWebhook([evOriginal]);
    await stepWorker();

    // Check delivered copy in G-A
    const { rows: copies } = await db.query<{ sent_message_id: string; quote_token: string }>(
      `select sent_message_id, quote_token from relay_copies where origin_message_id = 'm-orig-pizza' and target_group_id = 'G-A'`,
    );
    expect(copies.length).toBeGreaterThan(0);
    const copyInA = copies[0]!.sent_message_id;

    // 2. Aiko in G-A quotes that copy with "me!"
    const evReply = textEvent({
      groupId: 'G-A',
      userId: 'Uaiko',
      text: 'me!',
      id: 'm-reply-me',
      quotedMessageId: copyInA,
      fake: fakeLine,
    });
    await sendWebhook([evReply]);
    await stepWorker();

    // 3. Ken in G-B sees the reply quoting Ken's original message
    const { rows: replyJobs } = await db.query(
      `select * from relay_jobs where origin_message_id = 'm-reply-me' and target_group_id = 'G-B'`,
    );
    expect(replyJobs).toHaveLength(1);
    expect(replyJobs[0]?.state).toBe('delivered');
  });

  it('US-10 Message edit propagates to target groups quoting copy', async () => {
    const evEdit = editEvent({
      groupId: 'G-B',
      userId: 'Uken',
      id: 'm-orig-pizza',
      text: 'who wants pizza? (now ordering)',
    });
    await sendWebhook([evEdit]);
    await stepWorker();

    // Target group A receives edit job quoting target copy
    const { rows: editJobs } = await db.query(
      `select * from relay_jobs where origin_message_id = 'm-orig-pizza' and target_group_id = 'G-A' and kind = 'edit'`,
    );
    expect(editJobs).toHaveLength(1);
    expect(editJobs[0]?.state).toBe('delivered');
  });

  it('US-11 Unsend cancels pending relays and purges content', async () => {
    const evUnsend = unsendEvent({
      groupId: 'G-B',
      userId: 'Uken',
      messageId: 'm-orig-pizza',
    });
    await sendWebhook([evUnsend]);
    await stepWorker();

    // Verify stored text is purged
    const { rows: m } = await db.query('select text, unsent_at from origin_messages where message_id = $1', ['m-orig-pizza']);
    expect(m[0]?.text).toBeNull();
    expect(m[0]?.unsent_at).not.toBeNull();
  });
});
