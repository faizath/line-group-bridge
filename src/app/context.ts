import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { LinePlatform } from '../line/adapter.js';
import type { TokenProvider } from '../line/tokens.js';
import type { Logger } from '../logger.js';
import type { MediaService, MediaStore } from '../media/types.js';
import type { Metrics } from '../metrics.js';
import type { StickerPolicy } from '../translate/stickers.js';
import type { Clock } from '../util/clock.js';

/** Shared dependencies handed to every component. */
export interface AppContext {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  line: LinePlatform;
  media: MediaService;
  store: MediaStore;
  stickers: StickerPolicy;
  metrics: Metrics;
  tokens: TokenProvider | null;
  /** Unique per process; used as lease owner. */
  instanceId: string;
  /** Bot user ID (webhook `destination`), from config or discovered via GET /v2/bot/info. */
  bot: { userId: string | null };
}
