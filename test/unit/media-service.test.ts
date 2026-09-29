import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/db.js';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import type { LinePlatform } from '../../src/line/adapter.js';
import { LineApiError } from '../../src/line/adapter.js';
import { DefaultMediaService } from '../../src/media/service.js';
import { FsMediaStore } from '../../src/media/store.js';
import type { MediaMessage } from '../../src/media/types.js';
import { createLogger } from '../../src/logger.js';
import { ManualClock } from '../../src/util/clock.js';

describe('DefaultMediaService', () => {
  let tmpDir: string;
  let db: Db;
  let clock: ManualClock;
  let store: FsMediaStore;
  let service: DefaultMediaService;

  // Stored stub data for mock line client
  const contents = new Map<string, { data: Buffer; contentType: string; status?: number }>();
  let transcodeStatus: 'processing' | 'succeeded' | 'failed' = 'succeeded';

  const lineStub: Partial<LinePlatform> = {
    async getContent(id: string) {
      const c = contents.get(id);
      if (!c) throw new LineApiError('Not found', 404, `/v2/bot/message/${id}/content`);
      if (c.status === 202) return { status: 'preparing' };
      return { status: 'ready', contentType: c.contentType, data: c.data };
    },
    async getContentPreview(id: string) {
      const c = contents.get(id);
      if (!c) return null;
      return { contentType: c.contentType, data: c.data };
    },
    async getTranscodingStatus() {
      return transcodeStatus;
    },
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-media-srv-'));
    store = new FsMediaStore(tmpDir);
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
      FILE_RELAY_MAX_MB: '5',
    });

    service = new DefaultMediaService({
      db,
      line: lineStub as LinePlatform,
      store,
      config,
      clock,
      log: createLogger('silent'),
    });
  });

  afterAll(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('downloads and stores image, creating original and preview', async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    contents.set('msg-img-1', { data: png, contentType: 'image/png' });

    // Insert fake origin message
    await db.query(
      `insert into bridges (id, channel_id, name, delivery_mode) values ('00000000-0000-0000-0000-000000000001', 'ch', 'Bridge', 'batched')`,
    );
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts) values ('msg-img-1', '00000000-0000-0000-0000-000000000001', 'G1', 'image', $1)`,
      [clock.now()],
    );

    const msg: MediaMessage = {
      messageId: 'msg-img-1',
      type: 'image',
      meta: { contentProvider: { type: 'line' } },
      firstAttemptAt: clock.now(),
    };

    const outcome = await service.fetchForMessage(msg);
    expect(outcome.state).toBe('ready');

    const refs = await service.refs('msg-img-1', 'image', msg.meta, 'ready');
    expect(refs?.originalUrl).toMatch(/^https:\/\/media\.example\/m\/[A-Za-z0-9_-]+\/original\.(png|jpg)$/);
    expect(refs?.previewUrl).toMatch(/^https:\/\/media\.example\/m\/[A-Za-z0-9_-]+\/preview\.(png|jpg)$/);

    // Verify DB records exist
    const { rows } = await db.query('select * from media_objects where origin_message_id = $1', ['msg-img-1']);
    expect(rows.length).toBe(2);
  });

  it('converts WebP images to JPEG <= 10MB', async () => {
    const webp = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .webp()
      .toBuffer();

    contents.set('msg-webp-1', { data: webp, contentType: 'image/webp' });
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts) values ('msg-webp-1', '00000000-0000-0000-0000-000000000001', 'G1', 'image', $1)`,
      [clock.now()],
    );

    const msg: MediaMessage = {
      messageId: 'msg-webp-1',
      type: 'image',
      meta: { contentProvider: { type: 'line' } },
      firstAttemptAt: clock.now(),
    };

    const outcome = await service.fetchForMessage(msg);
    expect(outcome.state).toBe('ready');

    const refs = await service.refs('msg-webp-1', 'image', msg.meta, 'ready');
    expect(refs?.originalUrl).toContain('/original.jpg');
  });

  it('generates and caches default icon URL idempotently', async () => {
    const url1 = await service.defaultIconUrl();
    const url2 = await service.defaultIconUrl();
    expect(url1).toBe(url2);
    expect(url1).toMatch(/^https:\/\/media\.example\/i\/default\/[a-f0-9]+\.png$/);
  });

  it('purges stored media and DB rows for unsent messages', async () => {
    await service.purgeMessage('msg-img-1');
    const { rows } = await db.query('select * from media_objects where origin_message_id = $1', ['msg-img-1']);
    expect(rows).toHaveLength(0);
  });

  it('marks files exceeding cap as tooLarge in refs', async () => {
    const meta = { file: { name: 'huge.zip', size: 10 * 1024 * 1024 } }; // 10 MB > 5 MB cap
    const refs = await service.refs('msg-file-1', 'file', meta, 'none');
    expect(refs?.tooLarge).toBe(true);
  });

  it('handles video transcoding polling (preparing -> pending, succeeded -> ready)', async () => {
    contents.set('msg-vid-1', { data: Buffer.alloc(100), contentType: 'video/mp4', status: 202 });
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts) values ('msg-vid-1', '00000000-0000-0000-0000-000000000001', 'G1', 'video', $1)`,
      [clock.now()],
    );

    const msg: MediaMessage = {
      messageId: 'msg-vid-1',
      type: 'video',
      meta: { contentProvider: { type: 'line' } },
      firstAttemptAt: clock.now(),
    };

    transcodeStatus = 'processing';
    const pending = await service.fetchForMessage(msg);
    expect(pending.state).toBe('pending');

    // Simulate transcode finished
    contents.set('msg-vid-1', { data: Buffer.from('fake-mp4-data'), contentType: 'video/mp4' });
    transcodeStatus = 'succeeded';
    const ready = await service.fetchForMessage(msg);
    expect(ready.state).toBe('ready');
  });

  it('fails transcoding if more than 5 minutes elapsed', async () => {
    contents.set('msg-vid-stuck', { data: Buffer.alloc(100), contentType: 'video/mp4', status: 202 });
    await db.query(
      `insert into origin_messages (message_id, bridge_id, group_id, type, event_ts) values ('msg-vid-stuck', '00000000-0000-0000-0000-000000000001', 'G1', 'video', $1)`,
      [clock.now()],
    );

    const firstAttempt = clock.now();
    clock.advance(6 * 60 * 1000); // 6 minutes later
    transcodeStatus = 'processing';

    const msg: MediaMessage = {
      messageId: 'msg-vid-stuck',
      type: 'video',
      meta: { contentProvider: { type: 'line' } },
      firstAttemptAt: firstAttempt,
    };

    const outcome = await service.fetchForMessage(msg);
    expect(outcome.state).toBe('failed');
  });
});
