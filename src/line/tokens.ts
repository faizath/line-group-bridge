import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { channelAccessToken } from '@line/bot-sdk';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { alert, type Logger } from '../logger.js';
import type { Clock } from '../util/clock.js';
import { LineApiError } from './adapter.js';
import { callLine } from './client.js';
import type { RateLimiter } from './rateLimiter.js';

export type TokenMode = 'long_lived' | 'v21' | 'stateless';

export interface TokenProvider {
  getToken(): Promise<string>;
  /** Forces a re-issue on the next `getToken` (after a 401). No-op for long-lived tokens. */
  invalidate(): void;
  status(): { mode: TokenMode; expiresAt: Date | null };
}

export interface TokenProviderDeps {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  limiter: RateLimiter;
  /** Timeout for a single issuance request. */
  timeoutMs?: number;
}

const STATE_KEY = 'line_access_token';
const V21_TOKEN_EXP_S = 30 * 24 * 3600;
const V21_RENEW_FRACTION = 0.8;
const STATELESS_RENEW_MS = 10 * 60_000;
// After a failed renewal while the current token is still valid, wait before trying again so
// every API call does not queue behind the 1 req/s token bucket.
const RENEW_RETRY_MS = 60_000;

interface CachedToken {
  token: string;
  issuedAt: Date;
  expiresAt: Date;
  renewAt: Date;
}

export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  const { config } = deps;
  switch (config.LINE_TOKEN_MODE) {
    case 'long_lived': {
      const token = config.LINE_ACCESS_TOKEN;
      if (!token) throw new Error('LINE_ACCESS_TOKEN is required when LINE_TOKEN_MODE=long_lived');
      return {
        getToken: async () => token,
        invalidate: () => undefined,
        status: () => ({ mode: 'long_lived', expiresAt: null }),
      };
    }
    case 'v21':
      return new V21TokenProvider(deps);
    case 'stateless':
      return new StatelessTokenProvider(deps);
  }
}

/** Shared caching/single-flight logic; subclasses supply how a token is loaded and issued. */
abstract class IssuedTokenProvider implements TokenProvider {
  protected current: CachedToken | null = null;
  protected rejected: string | null = null;
  private inflight: Promise<string> | null = null;
  private nextAttemptAt = 0;
  protected readonly client: channelAccessToken.ChannelAccessTokenClient;

  constructor(
    protected readonly deps: TokenProviderDeps,
    readonly mode: TokenMode,
  ) {
    this.client = new channelAccessToken.ChannelAccessTokenClient({ baseURL: deps.config.LINE_API_BASE });
  }

  getToken(): Promise<string> {
    const now = this.deps.clock.now();
    const cur = this.current;
    if (cur && cur.token !== this.rejected && now < cur.renewAt) return Promise.resolve(cur.token);
    if (cur && cur.token !== this.rejected && now < cur.expiresAt && now.getTime() < this.nextAttemptAt) {
      return Promise.resolve(cur.token);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    if (this.current) this.rejected = this.current.token;
    this.nextAttemptAt = 0;
  }

  status(): { mode: TokenMode; expiresAt: Date | null } {
    return { mode: this.mode, expiresAt: this.current?.expiresAt ?? null };
  }

  private async refresh(): Promise<string> {
    const stored = await this.load();
    const now = this.deps.clock.now();
    if (stored && stored.token !== this.rejected && now < stored.renewAt) {
      this.current = stored;
      return stored.token;
    }
    try {
      await this.deps.limiter.acquire('token');
      const issued = await this.issue();
      this.current = issued;
      this.rejected = null;
      this.nextAttemptAt = 0;
      this.deps.log.info({ tokenMode: this.mode, expiresAt: issued.expiresAt.toISOString() }, 'line access token issued');
      return issued.token;
    } catch (err) {
      // A renewal failure is survivable while a non-rejected token has not yet expired.
      const fallback = [this.current, stored].find(
        (c): c is CachedToken => !!c && c.token !== this.rejected && this.deps.clock.now() < c.expiresAt,
      );
      alert(this.deps.log, 'line_token_issue_failed', {
        tokenMode: this.mode,
        status: err instanceof LineApiError ? err.status : undefined,
        error: err instanceof Error ? err.message : String(err),
        usingPreviousToken: !!fallback,
      });
      if (!fallback) throw err;
      this.current = fallback;
      this.nextAttemptAt = this.deps.clock.now().getTime() + RENEW_RETRY_MS;
      return fallback.token;
    }
  }

  protected abstract load(): Promise<CachedToken | null>;
  protected abstract issue(): Promise<CachedToken>;
}

class StatelessTokenProvider extends IssuedTokenProvider {
  constructor(deps: TokenProviderDeps) {
    super(deps, 'stateless');
  }

  protected async load(): Promise<CachedToken | null> {
    return this.current;
  }

  protected async issue(): Promise<CachedToken> {
    const { config, clock } = this.deps;
    const body = await callLine(
      this.deps,
      { endpoint: '/oauth2/v3/token', method: 'POST', timeoutMs: this.deps.timeoutMs },
      async () => {
        const r = await this.client.issueStatelessChannelTokenByClientSecretWithHttpInfo(
          config.channelId,
          config.LINE_CHANNEL_SECRET,
        );
        return { status: r.httpResponse.status, headers: r.httpResponse.headers, value: r.body };
      },
    );
    const issuedAt = clock.now();
    const lifetimeMs = body.expires_in * 1000;
    return {
      token: body.access_token,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + lifetimeMs),
      renewAt: new Date(issuedAt.getTime() + Math.min(STATELESS_RENEW_MS, lifetimeMs * V21_RENEW_FRACTION)),
    };
  }
}

interface StoredToken {
  token: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
}

/**
 * v2.1 tokens are issued with a JWT assertion and persisted (encrypted) in `system_state`, so
 * restarts and sibling processes reuse one token instead of burning the 30-per-channel allowance.
 */
class V21TokenProvider extends IssuedTokenProvider {
  private readonly privateKey: KeyObject;
  private readonly kid: string;
  private readonly storeKey: Buffer;

  constructor(deps: TokenProviderDeps) {
    super(deps, 'v21');
    const { config } = deps;
    if (!config.LINE_JWK_PRIVATE_KEY || !config.LINE_JWK_KID) {
      throw new Error('LINE_JWK_PRIVATE_KEY and LINE_JWK_KID are required when LINE_TOKEN_MODE=v21');
    }
    this.privateKey = createPrivateKey({ key: JSON.parse(config.LINE_JWK_PRIVATE_KEY), format: 'jwk' });
    this.kid = config.LINE_JWK_KID;
    this.storeKey = Buffer.from(hkdfSync('sha256', config.LINE_CHANNEL_SECRET, Buffer.alloc(0), 'lgb-token-store', 32));
  }

  protected async load(): Promise<CachedToken | null> {
    const { rows } = await this.deps.db.query<{ value: StoredToken }>('select value from system_state where key = $1', [
      STATE_KEY,
    ]);
    const v = rows[0]?.value;
    if (!v) return null;
    const token = this.decrypt(v.token);
    // Undecryptable (e.g. the channel secret was rotated): treat as absent and issue a new one.
    if (token === null) return null;
    const issuedAt = new Date(v.issuedAt);
    const expiresAt = new Date(v.expiresAt);
    return { token, issuedAt, expiresAt, renewAt: renewAt(issuedAt, expiresAt) };
  }

  protected async issue(): Promise<CachedToken> {
    const { clock, config, db } = this.deps;
    const jwt = this.assertion();
    const body = await callLine(
      this.deps,
      { endpoint: '/oauth2/v2.1/token', method: 'POST', timeoutMs: this.deps.timeoutMs },
      async () => {
        const r = await this.client.issueChannelTokenByJWTWithHttpInfo(
          'client_credentials',
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          jwt,
        );
        return { status: r.httpResponse.status, headers: r.httpResponse.headers, value: r.body };
      },
    );
    const issuedAt = clock.now();
    const expiresAt = new Date(issuedAt.getTime() + body.expires_in * 1000);
    const stored: StoredToken = {
      token: this.encrypt(body.access_token),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      keyId: body.key_id,
    };
    await db.query(
      `insert into system_state (key, value, updated_at) values ($1, $2::jsonb, $3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [STATE_KEY, JSON.stringify(stored), issuedAt],
    );
    this.deps.log.info({ keyId: body.key_id, channelId: config.channelId }, 'line v2.1 token persisted');
    return { token: body.access_token, issuedAt, expiresAt, renewAt: renewAt(issuedAt, expiresAt) };
  }

  private assertion(): string {
    const nowS = Math.floor(this.deps.clock.now().getTime() / 1000);
    const channelId = this.deps.config.channelId;
    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
    const payload = {
      iss: channelId,
      sub: channelId,
      aud: 'https://api.line.me/',
      exp: nowS + 30 * 60,
      token_exp: V21_TOKEN_EXP_S,
    };
    const input = [header, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
    const signature = sign('sha256', Buffer.from(input), this.privateKey).toString('base64url');
    return `${input}.${signature}`;
  }

  private encrypt(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.storeKey, iv);
    cipher.setAAD(Buffer.from(STATE_KEY));
    const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  private decrypt(sealed: string): string | null {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < 28) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.storeKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(STATE_KEY));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

function renewAt(issuedAt: Date, expiresAt: Date): Date {
  return new Date(issuedAt.getTime() + (expiresAt.getTime() - issuedAt.getTime()) * V21_RENEW_FRACTION);
}
