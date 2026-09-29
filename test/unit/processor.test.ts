import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { Commands } from '../../src/commands/handler.js';
import { loadConfig } from '../../src/config.js';
import { getGroup, registerGroup } from '../../src/core/groups.js';
import type { MediaService } from '../../src/media/types.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { Lanes } from '../../src/delivery/lanes.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import type { LineEvent } from '../../src/line/types.js';
import { createLogger } from '../../src/logger.js';
import { FsMediaStore } from '../../src/media/store.js';
import { Metrics } from '../../src/metrics.js';
import { EventProcessor } from '../../src/processor/processor.js';
import { StickerPolicy } from '../../src/translate/stickers.js';
import { ManualClock } from '../../src/util/clock.js';
import { uuid } from '../../src/util/ids.js';

describe('EventProcessor', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let quota: QuotaGuard;
  let commands: Commands;
  let lanes: Lanes;
  let processor: EventProcessor;
  let ctx: AppContext;
  let bridgeId: string;

  const lineStub: Partial<LinePlatform> = {
    async reply() {
      return { status: 200, sentMessages: [{ id: 'reply-1' }] };
    },
    async push() {
      return { status: 200, sentMessages: [{ id: 'push-1' }] };
    },
    async getGroupMemberCount() {
      return 50;
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
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-proc-test-'));
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
      instanceId: 'test-proc',
      bot: { userId: 'Ubot' },
    };

    quota = new QuotaGuard(ctx);
    commands = new Commands(ctx, quota);
    lanes = new Lanes(ctx, quota);
    processor = new EventProcessor(ctx, lanes, commands);

    // Setup a bridge with 2 attached groups (G-1, G-2)
    bridgeId = uuid();
    await db.query(
      `insert into bridges (id, channel_id, name, delivery_mode) values ($1, 'ch', 'Bridge 1', 'batched')`,
      [bridgeId],
    );
    await registerGroup(db, ctx, 'G-1', clock.now());
    await registerGroup(db, ctx, 'G-2', clock.now());
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'A', relay_in = true, relay_out = true where group_id = 'G-1'`,
      [bridgeId],
    );
    await db.query(
      `update member_groups set bridge_id = $1, state = 'attached', short_tag = 'B', relay_in = true, relay_out = true where group_id = 'G-2'`,
      [bridgeId],
    );
  });

  afterAll(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function pushEvent(ev: Partial<LineEvent>): Promise<void> {
    const full: LineEvent = {
      type: ev.type ?? 'message',
      timestamp: ev.timestamp ?? clock.now().getTime(),
      webhookEventId: ev.webhookEventId ?? `ev-${uuid()}`,
      deliveryContext: { isRedelivery: false },
      source: ev.source ?? { type: 'group', groupId: 'G-1', userId: 'Ualice' },
      ...ev,
    };
    await db.query(
      `insert into inbound_events (webhook_event_id, channel_id, type, group_id, event_ts, received_at, is_redelivery, payload, state)
       values ($1, 'ch', $2, $3, $4, $5, false, $6, 'pending')`,
      [full.webhookEventId, full.type, full.source?.groupId ?? null, new Date(full.timestamp), clock.now(), JSON.stringify(full)],
    );
  }

  it('processes plain text message and creates relay job for target group', async () => {
    await pushEvent({
      type: 'message',
      message: { id: 'msg-proc-1', type: 'text', text: 'hello from G-1' },
    });

    const count = await processor.runBatch();
    expect(count).toBe(1);

    // Verify origin_messages
    const { rows: msgs } = await db.query('select * from origin_messages where message_id = $1', ['msg-proc-1']);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe('hello from G-1');

    // Verify relay_jobs created for G-2
    const { rows: jobs } = await db.query('select * from relay_jobs where origin_message_id = $1', ['msg-proc-1']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.target_group_id).toBe('G-2');
    expect(jobs[0]?.state).toBe('queued');
  });

  it('ignores standby mode events', async () => {
    await pushEvent({
      mode: 'standby',
      type: 'message',
      message: { id: 'msg-standby', type: 'text', text: 'ignore me' },
    });

    const count = await processor.runBatch();
    expect(count).toBe(1);

    const { rows } = await db.query('select * from origin_messages where message_id = $1', ['msg-standby']);
    expect(rows).toHaveLength(0);
  });

  it('ignores messages from the bot itself (loop guard)', async () => {
    await pushEvent({
      type: 'message',
      source: { type: 'group', groupId: 'G-1', userId: 'Ubot' },
      message: { id: 'msg-bot', type: 'text', text: 'bot self message' },
    });

    await processor.runBatch();
    const { rows } = await db.query('select * from origin_messages where message_id = $1', ['msg-bot']);
    expect(rows).toHaveLength(0);
  });

  it('handles messageEdited by updating origin text and creating edit job if copy exists', async () => {
    // 1. Simulate that msg-proc-1 has a delivered copy in G-2
    await db.query(
      `insert into relay_copies (target_group_id, sent_message_id, origin_message_id, part_index, quote_token)
       values ('G-2', 'sent-111', 'msg-proc-1', 0, 'quote-tok-1')`,
    );

    // 2. Push messageEdited event
    await pushEvent({
      type: 'messageEdited',
      message: { id: 'msg-proc-1', type: 'text', text: 'hello from G-1 (edited)' },
    });

    await processor.runBatch();

    // Verify origin message text updated
    const { rows: msgs } = await db.query('select * from origin_messages where message_id = $1', ['msg-proc-1']);
    expect(msgs[0]?.text).toBe('hello from G-1 (edited)');
    expect(msgs[0]?.edit_count).toBe(1);

    // Verify edit relay job created for G-2
    const { rows: editJobs } = await db.query(
      `select * from relay_jobs where origin_message_id = $1 and kind = 'edit'`,
      ['msg-proc-1'],
    );
    expect(editJobs).toHaveLength(1);
    expect(editJobs[0]?.target_group_id).toBe('G-2');
  });

  it('handles unsend by canceling pending jobs, purging text and queueing unsend notice', async () => {
    // msg-proc-1 already has a delivered copy in G-2
    await pushEvent({
      type: 'unsend',
      unsend: { messageId: 'msg-proc-1' },
    });

    await processor.runBatch();

    // Verify origin message text is purged
    const { rows: msgs } = await db.query('select * from origin_messages where message_id = $1', ['msg-proc-1']);
    expect(msgs[0]?.text).toBeNull();
    expect(msgs[0]?.unsent_at).not.toBeNull();

    // Verify unsend notice was queued for G-2
    const { rows: noticeJobs } = await db.query(
      `select * from relay_jobs where origin_message_id = $1 and kind = 'unsend_notice'`,
      ['msg-proc-1'],
    );
    expect(noticeJobs).toHaveLength(1);
    expect(noticeJobs[0]?.target_group_id).toBe('G-2');
  });

  it('handles join event by registering group and refreshing meta', async () => {
    await pushEvent({
      type: 'join',
      source: { type: 'group', groupId: 'G-New' },
      replyToken: 'tok-onboard',
    });

    await processor.runBatch();
    const g = await getGroup(db, 'G-New');
    expect(g?.state).toBe('unattached');
    expect(g?.name).toBe('Group G-New');
  });

  it('handles leave event by setting state to bot_removed and canceling jobs', async () => {
    // Queue a job for G-2
    await db.query(
      `insert into relay_jobs (id, bridge_id, origin_message_id, target_group_id, kind, state, order_ts, ready_at)
       values ('00000000-0000-0000-0000-000000000099', $1, null, 'G-2', 'notice', 'queued', $2, $2)`,
      [bridgeId, clock.now()],
    );

    await pushEvent({
      type: 'leave',
      source: { type: 'group', groupId: 'G-2' },
    });

    await processor.runBatch();
    const g2 = await getGroup(db, 'G-2');
    expect(g2?.state).toBe('bot_removed');

    const { rows: cancelled } = await db.query(
      `select * from relay_jobs where id = '00000000-0000-0000-0000-000000000099'`,
    );
    expect(cancelled[0]?.state).toBe('cancelled');
  });
});
