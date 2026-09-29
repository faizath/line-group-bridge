/** Time source. Every time-dependent decision goes through it so tests can drive time. */
export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep(ms, signal) {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (signal?.aborted) {
      resolve();
      return promise;
    }
    const done = () => {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    return promise;
  },
};

/** Manually advanced clock for tests; sleep resolves immediately. */
export class ManualClock implements Clock {
  constructor(private t: number = Date.parse('2026-09-29T00:00:00Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(d: Date | number): void {
    this.t = typeof d === 'number' ? d : d.getTime();
  }
  async sleep(): Promise<void> {}
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}
