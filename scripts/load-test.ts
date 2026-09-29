import autocannon from 'autocannon';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicApp } from '../src/app/app.js';
import type { AppContext } from '../src/app/context.js';
import { loadConfig } from '../src/config.js';
import { registerGroup } from '../src/core/groups.js';
import { openDb } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { SdkLineClient } from '../src/line/client.js';
import { NoopRateLimiter } from '../src/line/rateLimiter.js';
import { createTokenProvider } from '../src/line/tokens.js';
import { createLogger } from '../src/logger.js';
import { DefaultMediaService } from '../src/media/service.js';
import { FsMediaStore } from '../src/media/store.js';
import { Metrics } from '../src/metrics.js';
import { StickerPolicy } from '../src/translate/stickers.js';
import { systemClock } from '../src/util/clock.js';
import { uuid } from '../src/util/ids.js';
import { createFakeLine } from '../test/fake-line/server.js';
import { signBody } from '../test/fake-line/webhook.js';

async function runLoadTest(): Promise<void> {
  console.log('--- Initializing Load Test Environment (NFR-SCALE, NFR-PERF-1) ---');
  const tmpDir = await mkdtemp(join(tmpdir(), 'lgb-load-test-'));
  const db = await openDb('pglite://memory');
  await migrate(db);

  const secret = 'load-test-secret-key-12345';
  const botId = 'Uload-test-bot';

  const fakeLine = await createFakeLine({
    channelSecret: secret,
    botUserId: botId,
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
  });

  const store = new FsMediaStore(tmpDir);
  const log = createLogger('silent');
  const clock = systemClock;
  const limiter = new NoopRateLimiter();
  const tokens = createTokenProvider({ config, db, clock, log, limiter });
  const line = new SdkLineClient({ config, tokens, limiter, log, clock });
  const media = new DefaultMediaService({ db, line, store, config, clock, log });
  const stickers = new StickerPolicy();
  const metrics = new Metrics();

  const ctx: AppContext = {
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
    instanceId: 'load-test',
    bot: { userId: botId },
  };

  // Seed group
  await registerGroup(db, ctx, 'G-Load-1', clock.now());

  const app = buildPublicApp(ctx);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  console.log(`Target server listening at ${address}`);

  // Pre-generate a batch of signed webhook payloads
  const samples = Array.from({ length: 50 }, (_, i) => {
    const raw = JSON.stringify({
      destination: botId,
      events: [
        {
          type: 'message',
          timestamp: Date.now(),
          webhookEventId: `load-${i}-${uuid()}`,
          deliveryContext: { isRedelivery: false },
          source: { type: 'group', groupId: 'G-Load-1', userId: 'Uload-user' },
          message: { id: `m-load-${i}`, type: 'text', text: `load message ${i}` },
        },
      ],
    });
    const sig = signBody(secret, raw);
    return { raw, sig };
  });

  let sampleIdx = 0;

  console.log('Running 200 connections burst for 5 seconds...');
  const result = await autocannon({
    url: `${address}/webhook`,
    method: 'POST',
    connections: 50,
    duration: 5,
    requests: [
      {
        setupRequest: (req) => {
          const sample = samples[sampleIdx++ % samples.length]!;
          req.headers = {
            'Content-Type': 'application/json',
            'X-Line-Signature': sample.sig,
          };
          req.body = sample.raw;
          return req;
        },
      },
    ],
  });

  console.log('--- Load Test Results ---');
  console.log(`Requests: ${result.requests.total} total (${result.requests.average} req/sec)`);
  console.log(`2xx Responses: ${result['2xx']}`);
  console.log(`Non-2xx Responses: ${result.non2xx}`);
  console.log(`Latency p50: ${result.latency.p50} ms`);
  console.log(`Latency p99: ${result.latency.p99} ms`);

  // Cleanup
  await app.close();
  await fakeLine.close();
  await db.close();
  await rm(tmpDir, { recursive: true, force: true });

  if (result.non2xx > 0) {
    console.error('FAIL: Load test encountered non-2xx responses!');
    process.exit(1);
  }
  if (result.latency.p99 > 500) {
    console.error(`FAIL: p99 latency (${result.latency.p99} ms) exceeded NFR-PERF-1 threshold (500 ms)!`);
    process.exit(1);
  }

  console.log('SUCCESS: All load test assertions satisfied!');
}

runLoadTest().catch((err) => {
  console.error('Load test failed with error:', err);
  process.exit(1);
});
