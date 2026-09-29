import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { DbRateLimiter } from '../../src/line/rateLimiter.js';
import { ManualClock } from '../../src/util/clock.js';

/** Sleeping advances simulated time, so waits become observable as clock movement. */
class SteppingClock extends ManualClock {
  slept = 0;
  override async sleep(ms: number): Promise<void> {
    this.slept += ms;
    this.advance(ms);
  }
}

let db: Db;

beforeAll(async () => {
  db = await openDb('pglite://memory');
  await migrate(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from rate_buckets');
});

describe('DbRateLimiter', () => {
  it('allows a burst of `rps` requests, then waits 1/rps s per request', async () => {
    const clock = new SteppingClock();
    const limiter = new DbRateLimiter({ db, clock, rps: 5 });
    for (let i = 0; i < 5; i++) await limiter.acquire('api');
    expect(clock.slept).toBe(0);
    await limiter.acquire('api');
    expect(clock.slept).toBe(200);
    await limiter.acquire('api');
    expect(clock.slept).toBe(400);
  });

  it('never refills beyond capacity after a long idle period', async () => {
    const clock = new SteppingClock();
    const limiter = new DbRateLimiter({ db, clock, rps: 3 });
    await limiter.acquire('api');
    clock.advance(3_600_000);
    for (let i = 0; i < 3; i++) await limiter.acquire('api');
    expect(clock.slept).toBe(0);
    await limiter.acquire('api');
    expect(clock.slept).toBeGreaterThan(0);
  });

  it('keeps buckets independent and uses tokenRps for the token bucket', async () => {
    const clock = new SteppingClock();
    const limiter = new DbRateLimiter({ db, clock, rps: 2, tokenRps: 0.5 });
    await limiter.acquire('api');
    await limiter.acquire('api');
    await limiter.acquire('data');
    await limiter.acquire('data');
    await limiter.acquire('token');
    expect(clock.slept).toBe(0);
    await limiter.acquire('token');
    expect(clock.slept).toBe(2000);
  });

  it('shares one budget between limiter instances on the same database', async () => {
    const clock = new SteppingClock();
    const a = new DbRateLimiter({ db, clock, rps: 4 });
    const b = new DbRateLimiter({ db, clock, rps: 4 });
    await a.acquire('api');
    await b.acquire('api');
    await a.acquire('api');
    await b.acquire('api');
    expect(clock.slept).toBe(0);
    await b.acquire('api');
    expect(clock.slept).toBe(250);
  });

  it('does not mint tokens for a process whose clock lags behind', async () => {
    const ahead = new SteppingClock();
    const behind = new SteppingClock(ahead.now().getTime() - 10_000);
    const a = new DbRateLimiter({ db, clock: ahead, rps: 5 });
    const b = new DbRateLimiter({ db, clock: behind, rps: 5 });
    for (let i = 0; i < 5; i++) await a.acquire('api');
    await b.acquire('api');
    // b had to wait until its own clock passed the last update plus one refill interval.
    expect(behind.now().getTime()).toBeGreaterThanOrEqual(ahead.now().getTime() + 200);
  });

  it('never admits more than capacity + rate × elapsed in any window', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 5, maxLength: 60 }),
        async (rps, gaps) => {
          await db.query('delete from rate_buckets');
          const clock = new SteppingClock();
          const limiter = new DbRateLimiter({ db, clock, rps });
          const times: number[] = [];
          for (const gap of gaps) {
            clock.advance(gap);
            await limiter.acquire('data');
            times.push(clock.now().getTime());
          }
          for (let i = 0; i < times.length; i++) {
            for (let j = i; j < times.length; j++) {
              const admitted = j - i + 1;
              const allowed = rps + (rps * (times[j]! - times[i]!)) / 1000;
              expect(admitted).toBeLessThanOrEqual(allowed + 1e-9);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
