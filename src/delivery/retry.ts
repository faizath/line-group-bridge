import { LineApiError } from '../line/adapter.js';

/** Retry bounds for pushes (NFR-REL-4); always far inside the 24 h retry-key window. */
export const MAX_PUSH_ATTEMPTS = 8;
export const MAX_RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Jobs whose retry key is older than this are never retried with it (24 h key window minus margin). */
export const RETRY_KEY_MAX_AGE_MS = 23 * 60 * 60 * 1000;
/** Last fallback-ladder step ([09] §9 steps 1–4); beyond it the job is dead. */
export const MAX_FALLBACK_STEP = 4;

export type FailureClass =
  | { kind: 'retry'; reason: 'timeout' | 'server' | 'rate_limited' | 'unauthorized' }
  | { kind: 'monthly_limit' }
  | { kind: 'bad_request' }
  | { kind: 'fatal'; status: number };

/** Classifies a failed send (FR-RLY-3): 5xx/timeouts retry, 429 splits into rate vs. quota, 400 runs the ladder. */
export function classify(err: unknown): FailureClass {
  if (!(err instanceof LineApiError)) return { kind: 'retry', reason: 'timeout' };
  if (err.status === 0) return { kind: 'retry', reason: 'timeout' };
  if (err.status >= 500) return { kind: 'retry', reason: 'server' };
  if (err.status === 429) return err.isMonthlyLimit ? { kind: 'monthly_limit' } : { kind: 'retry', reason: 'rate_limited' };
  // A revoked/expired token is not the message's fault; the token provider re-issues and we retry.
  if (err.status === 401) return { kind: 'retry', reason: 'unauthorized' };
  if (err.status === 400) return { kind: 'bad_request' };
  return { kind: 'fatal', status: err.status };
}

/** Exponential backoff with full jitter: 1 s, 2 s, 4 s … capped at 5 min. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + (random() * cap) / 2);
}

/** "Invalid reply token" and friends: the token, not the content, was rejected. */
export function isReplyTokenError(err: unknown): boolean {
  return err instanceof LineApiError && err.status === 400 && /reply ?token/i.test(err.message);
}
