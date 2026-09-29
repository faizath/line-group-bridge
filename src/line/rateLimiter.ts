import type { Db } from '../db/db.js';
import type { Clock } from '../util/clock.js';

export type RateBucket = 'api' | 'data' | 'token';

export interface RateLimiter {
  /** Resolves once one request may be sent on `bucket`. */
  acquire(bucket: RateBucket): Promise<void>;
}

export class NoopRateLimiter implements RateLimiter {
  async acquire(): Promise<void> {}
}

interface BucketSpec {
  rate: number;
  capacity: number;
}

/**
 * Token bucket persisted in `rate_buckets`, so every web/worker process draws from one
 * budget and the channel as a whole stays under LINE's per-channel limits (NFR-SCALE-2).
 * Capacity equals the per-second rate: at most one second of burst.
 */
export class DbRateLimiter implements RateLimiter {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly specs: Record<RateBucket, BucketSpec>;
  private readonly initialized = new Set<RateBucket>();

  constructor(opts: { db: Db; clock: Clock; rps: number; tokenRps?: number }) {
    const tokenRps = opts.tokenRps ?? 1;
    if (!(opts.rps > 0) || !(tokenRps > 0)) throw new Error('rate limits must be positive');
    this.db = opts.db;
    this.clock = opts.clock;
    // Capacity below one token would make the bucket unusable; sub-1 rps still allows one request per 1/rps s.
    const spec = (rate: number): BucketSpec => ({ rate, capacity: Math.max(1, rate) });
    this.specs = { api: spec(opts.rps), data: spec(opts.rps), token: spec(tokenRps) };
  }

  async acquire(bucket: RateBucket): Promise<void> {
    const { rate, capacity } = this.specs[bucket];
    if (!this.initialized.has(bucket)) {
      await this.db.query(
        'insert into rate_buckets (name, tokens, updated_at) values ($1, $2, $3) on conflict (name) do nothing',
        [bucket, capacity, this.clock.now()],
      );
      this.initialized.add(bucket);
    }
    for (;;) {
      const now = this.clock.now();
      // Elapsed time is clamped at 0 and updated_at never moves backwards, so a process whose
      // clock lags behind another's cannot mint extra tokens.
      const taken = await this.db.query(
        `update rate_buckets
            set tokens = least($2::float8, tokens + greatest(0, extract(epoch from ($3::timestamptz - updated_at))::float8) * $4::float8) - 1,
                updated_at = greatest(updated_at, $3::timestamptz)
          where name = $1
            and least($2::float8, tokens + greatest(0, extract(epoch from ($3::timestamptz - updated_at))::float8) * $4::float8) >= 1
          returning tokens`,
        [bucket, capacity, now, rate],
      );
      if (taken.rowCount > 0) return;

      const { rows } = await this.db.query<{ available: number }>(
        `select least($2::float8, tokens + greatest(0, extract(epoch from ($3::timestamptz - updated_at))::float8) * $4::float8) as available
           from rate_buckets where name = $1`,
        [bucket, capacity, now, rate],
      );
      const available = rows[0]?.available ?? 0;
      await this.clock.sleep(Math.max(1, Math.ceil(((1 - available) / rate) * 1000)));
    }
  }
}
