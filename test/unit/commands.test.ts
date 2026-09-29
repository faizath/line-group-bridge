import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { Commands } from '../../src/commands/handler.js';
import { loadConfig } from '../../src/config.js';
import { getBridge, getGroup, registerGroup } from '../../src/core/groups.js';
import { QuotaGuard } from '../../src/cost/quotaGuard.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { Mentionee, OutboundMessage } from '../../src/line/types.js';
import type { MediaService } from '../../src/media/types.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import { createLogger } from '../../src/logger.js';
import { FsMediaStore } from '../../src/media/store.js';
import { Metrics } from '../../src/metrics.js';
import { StickerPolicy } from '../../src/translate/stickers.js';
import { ManualClock } from '../../src/util/clock.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Commands handler', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let quota: QuotaGuard;
  let commands: Commands;
  let repliedMessages: OutboundMessage[] = [];

  const lineStub: Partial<LinePlatform> = {
    async reply(_token, messages) {
      repliedMessages.push(...messages);
      return { status: 200, sentMessages: [{ id: 'reply-1' }] };
    },
    async push() {
      return { status: 200, sentMessages: [{ id: 'push-1' }] };
    },
    async getGroupMemberCount() {
      return 100;
    },
    async getGroupSummary(id) {
      return { groupId: id, groupName: `Group ${id}` };
    },
    async getGroupMemberProfile(_gid, uid) {
      return { userId: uid, displayName: `User ${uid}` };
    },
    async leaveGroup() {},
    async getQuota() {
      return { type: 'limited', value: 100000 };
    },
    async getQuotaConsumption() {
      return { totalUsage: 1000 };
    },
  };

  let ctx: AppContext;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-cmd-test-'));
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
      OPERATOR_USER_IDS: 'Uoperator',
      BRIDGE_CREATE_POLICY: 'anyone',
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
      } as unknown as MediaService,
      store,
      stickers: new StickerPolicy(),
      metrics: new Metrics(),
      tokens: null,
      instanceId: 'test-inst',
      bot: { userId: 'Ubot' },
    };
    quota = new QuotaGuard(ctx);
    commands = new Commands(ctx, quota);
  });

  afterAll(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function sendCmd(groupId: string, userId: string | null, text: string, mentionees: Mentionee[] = []): Promise<string> {
    repliedMessages = [];
    const parsed = commands.parse({ id: 'm-probe', type: 'text', text, mention: { mentionees } });
    expect(parsed).not.toBeNull();
    await commands.handle(
      {
        groupId,
        userId,
        message: { id: 'm-cmd', type: 'text', text, mention: { mentionees } },
        replyToken: `tok-${Date.now()}-${Math.random()}`,
        webhookEventId: `ev-${Math.random()}`,
        receivedAt: clock.now(),
      },
      parsed!,
    );
    return repliedMessages.map((m) => (m.type === 'text' ? m.text : '')).join('\n');
  }

  it('rejects commands from users without profile consent', async () => {
    await registerGroup(db, ctx, 'G1', clock.now());
    const reply = await sendCmd('G1', null, '/bridge help');
    expect(reply).toContain('require LINE profile consent');
  });

  it('provides /bridge help listing available commands', async () => {
    await registerGroup(db, ctx, 'G1', clock.now());
    const reply = await sendCmd('G1', 'Uuser1', '/bridge help');
    expect(reply).toContain('/bridge status');
    expect(reply).toContain('/bridge optout');
  });

  it('creates a bridge with /bridge create and joins with /bridge join', async () => {
    await registerGroup(db, ctx, 'G-Alpha', clock.now());
    await registerGroup(db, ctx, 'G-Beta', clock.now());

    // 1. Create bridge in G-Alpha
    const createReply = await sendCmd('G-Alpha', 'Ualice', '/bridge create Alumni');
    expect(createReply).toContain('Bridge «Alumni» created');
    expect(createReply).toContain('group A');

    // Extract link code
    const codeMatch = /[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}/.exec(createReply);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![0];

    // Check G-Alpha is attached as tag A
    const gAlpha = await getGroup(db, 'G-Alpha');
    expect(gAlpha?.state).toBe('attached');
    expect(gAlpha?.short_tag).toBe('A');

    // 2. Join bridge in G-Beta using code
    const joinReply = await sendCmd('G-Beta', 'Ubob', `/bridge join ${code}`);
    expect(joinReply).toContain('Joined bridge «Alumni» as group B');

    const gBeta = await getGroup(db, 'G-Beta');
    expect(gBeta?.state).toBe('attached');
    expect(gBeta?.short_tag).toBe('B');

    // 3. Reusing code fails (single-use)
    await registerGroup(db, ctx, 'G-Gamma', clock.now());
    const reuseReply = await sendCmd('G-Gamma', 'Ucharlie', `/bridge join ${code}`);
    expect(reuseReply).toContain('Invalid or expired link code');
  });

  it('shows bridge status with member groups and delivery mode', async () => {
    const statusReply = await sendCmd('G-Alpha', 'Ualice', '/bridge status');
    expect(statusReply).toContain('Bridge: «Alumni»');
    expect(statusReply).toContain('[A]');
    expect(statusReply).toContain('[B]');
    expect(statusReply).toContain('batched');
  });

  it('changes delivery mode with /bridge mode, requiring confirm for immediate', async () => {
    // Attempt immediate without confirm
    const warnReply = await sendCmd('G-Alpha', 'Ualice', '/bridge mode immediate');
    expect(warnReply).toContain('Immediate mode pushes every message individually');
    expect(warnReply).toContain('/bridge mode immediate confirm');

    // Confirm immediate
    const confirmReply = await sendCmd('G-Alpha', 'Ualice', '/bridge mode immediate confirm');
    expect(confirmReply).toContain('Delivery mode updated to immediate');

    const g = await getGroup(db, 'G-Alpha');
    const bridge = await getBridge(db, g!.bridge_id!);
    expect(bridge?.delivery_mode).toBe('immediate');
  });

  it('toggles pause and resume per group', async () => {
    const pauseReply = await sendCmd('G-Alpha', 'Ualice', '/bridge pause out');
    expect(pauseReply).toContain('Relays from this group have been paused');

    let g = await getGroup(db, 'G-Alpha');
    expect(g?.relay_out).toBe(false);
    expect(g?.relay_in).toBe(true);

    const resumeReply = await sendCmd('G-Alpha', 'Ualice', '/bridge resume');
    expect(resumeReply).toContain('Relays for this group have been resumed');

    g = await getGroup(db, 'G-Alpha');
    expect(g?.relay_out).toBe(true);
  });

  it('supports muting and unmuting members', async () => {
    const muteReply = await sendCmd('G-Alpha', 'Ualice', '/bridge mute @spammer', [
      { type: 'user', userId: 'Uspammer', index: 13, length: 8 },
    ]);
    expect(muteReply).toContain('has been muted bridge-wide');

    const unmuteReply = await sendCmd('G-Alpha', 'Ualice', '/bridge unmute @spammer', [
      { type: 'user', userId: 'Uspammer', index: 15, length: 8 },
    ]);
    expect(unmuteReply).toContain('has been unmuted');
  });

  it('allows members to opt out and opt back in', async () => {
    const optoutReply = await sendCmd('G-Alpha', 'Ubob', '/bridge optout');
    expect(optoutReply).toContain('You have opted out');

    const optinReply = await sendCmd('G-Alpha', 'Ubob', '/bridge optin');
    expect(optinReply).toContain('You have opted in');
  });

  it('allows admin role management and rejects non-admin mutations', async () => {
    // Non-admin attempting to change mode
    const deniedReply = await sendCmd('G-Beta', 'Ubob', '/bridge mode batched');
    expect(deniedReply).toContain('You are not authorized');

    // Owner (Alice) promotes Bob to admin
    const promoteReply = await sendCmd('G-Alpha', 'Ualice', '/bridge admin add @bob', [
      { type: 'user', userId: 'Ubob', index: 19, length: 4 },
    ]);
    expect(promoteReply).toContain('was added as Admin');

    // Now Bob can change mode
    const successReply = await sendCmd('G-Beta', 'Ubob', '/bridge mode batched');
    expect(successReply).toContain('Delivery mode updated to batched');
  });

  it('detaches a group with /bridge leave', async () => {
    const leaveReply = await sendCmd('G-Beta', 'Ubob', '/bridge leave');
    expect(leaveReply).toContain('detached from bridge');

    const gBeta = await getGroup(db, 'G-Beta');
    expect(gBeta?.state).toBe('detached');
    expect(gBeta?.bridge_id).toBeNull();
  });
});
