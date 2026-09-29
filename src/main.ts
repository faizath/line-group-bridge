import { Commands } from './commands/handler.js';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { Lanes } from './delivery/lanes.js';
import { QuotaGuard } from './cost/quotaGuard.js';
import { SdkLineClient } from './line/client.js';
import { DbRateLimiter, NoopRateLimiter } from './line/rateLimiter.js';
import { createTokenProvider } from './line/tokens.js';
import { createLogger } from './logger.js';
import { DefaultMediaService } from './media/service.js';
import { createMediaStore } from './media/store.js';
import { Metrics } from './metrics.js';
import { EventProcessor } from './processor/processor.js';
import { Scheduler } from './core/scheduler.js';
import { loadStickerAllowlist } from './translate/stickers.js';
import { systemClock } from './util/clock.js';
import { uuid } from './util/ids.js';
import { buildAdminApp, buildPublicApp } from './app/app.js';
import type { AppContext } from './app/context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, { logMessageText: config.LOG_MESSAGE_TEXT });
  const clock = systemClock;
  const metrics = new Metrics({ defaultMetrics: true });
  const instanceId = `${process.pid}-${uuid().slice(0, 8)}`;

  log.info({ role: config.ROLE, instanceId }, 'starting line-group-bridge');

  const db = await openDb(config.DATABASE_URL);
  const limiter = db.kind === 'pg'
    ? new DbRateLimiter({ db, clock, rps: config.RATE_LIMIT_RPS })
    : new NoopRateLimiter();

  const tokens = createTokenProvider({ config, db, clock, log, limiter });
  const line = new SdkLineClient({
    config,
    tokens,
    limiter,
    log,
    clock,
    onApiCall: (e) => {
      metrics.lineApiCalls.inc({ endpoint: e.endpoint, status: String(e.status) });
      metrics.lineApiLatency.observe({ endpoint: e.endpoint }, e.ms / 1000);
    },
  });

  const store = createMediaStore(config);
  const media = new DefaultMediaService({ db, line, store, config, clock, log });
  const stickers = loadStickerAllowlist(config.STICKER_ALLOWLIST_PATH);

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
    instanceId,
    bot: { userId: config.LINE_BOT_USER_ID ?? null },
  };

  // Discover bot user ID if not configured
  if (!ctx.bot.userId) {
    try {
      const info = await line.getBotInfo();
      ctx.bot.userId = info.userId;
      log.info({ botUserId: info.userId, displayName: info.displayName }, 'discovered bot identity');
    } catch (err) {
      log.warn({ err }, 'could not discover bot identity at startup; will retry on readyz');
    }
  }

  const quota = new QuotaGuard(ctx);
  const commands = new Commands(ctx, quota);
  const lanes = new Lanes(ctx, quota);
  const processor = new EventProcessor(ctx, lanes, commands);
  const scheduler = new Scheduler(ctx, processor, lanes, quota);

  const isWeb = config.ROLE === 'web' || config.ROLE === 'all';
  const isWorker = config.ROLE === 'worker' || config.ROLE === 'all';

  const publicApp = isWeb ? buildPublicApp(ctx) : null;
  const adminApp = isWeb ? buildAdminApp(ctx, quota) : null;

  if (publicApp) {
    await publicApp.listen({ port: config.PORT, host: config.HOST });
    log.info({ port: config.PORT, host: config.HOST }, 'public server listening');
  }
  if (adminApp) {
    await adminApp.listen({ port: config.ADMIN_PORT, host: config.ADMIN_HOST });
    log.info({ port: config.ADMIN_PORT, host: config.ADMIN_HOST }, 'admin server listening');
  }

  if (isWorker) {
    // Run worker loop in background
    scheduler.start().catch((err: unknown) => {
      log.fatal({ err }, 'fatal error in worker scheduler');
      process.exit(1);
    });
  }

  // Graceful shutdown (NFR-REL-6)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down gracefully');

    scheduler.stop();
    if (publicApp) await publicApp.close();
    if (adminApp) await adminApp.close();
    await lanes.releaseAll();
    await db.close();

    log.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
