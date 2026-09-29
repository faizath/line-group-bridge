import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { LineApiError } from '../../src/line/adapter.js';
import { NoopRateLimiter } from '../../src/line/rateLimiter.js';
import { createTokenProvider } from '../../src/line/tokens.js';
import { createLogger } from '../../src/logger.js';
import { ManualClock } from '../../src/util/clock.js';

const log = createLogger('silent');
const limiter = new NoopRateLimiter();

let app: FastifyInstance;
let base: string;
let db: Db;
let publicKey: KeyObject;
let privateJwk: string;
let issued: { path: string; form: Record<string, string>; token: string }[] = [];
let expiresIn = 30 * 24 * 3600;
let failIssue = false;

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey;
  privateJwk = JSON.stringify(pair.privateKey.export({ format: 'jwk' }));

  app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  for (const path of ['/oauth2/v2.1/token', '/oauth2/v3/token']) {
    app.post(path, async (req, reply) => {
      if (failIssue) return reply.code(400).send({ error: 'invalid_client', error_description: 'bad assertion' });
      const token = `tok-${issued.length + 1}`;
      issued.push({ path, form: req.body as Record<string, string>, token });
      return { access_token: token, expires_in: expiresIn, token_type: 'Bearer', key_id: `kid-${issued.length}` };
    });
  }
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  db = await openDb('pglite://memory');
  await migrate(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  issued = [];
  expiresIn = 30 * 24 * 3600;
  failIssue = false;
  await db.query('delete from system_state');
});

function config(overrides: Record<string, string>): Config {
  return loadConfig({
    LINE_CHANNEL_SECRET: 'channel-secret',
    DATABASE_URL: 'pglite://memory',
    MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
    MEDIA_BACKEND: 'fs',
    LINE_API_BASE: base,
    LINE_CHANNEL_ID: '1234567890',
    ...overrides,
  });
}

const v21Config = () =>
  config({ LINE_TOKEN_MODE: 'v21', LINE_JWK_PRIVATE_KEY: privateJwk, LINE_JWK_KID: 'my-kid' });

describe('long_lived tokens', () => {
  it('returns the configured token and has no expiry', async () => {
    const clock = new ManualClock();
    const p = createTokenProvider({ config: config({ LINE_ACCESS_TOKEN: 'static' }), db, clock, log, limiter });
    p.invalidate();
    expect(await p.getToken()).toBe('static');
    expect(p.status()).toEqual({ mode: 'long_lived', expiresAt: null });
    expect(issued).toHaveLength(0);
  });
});

describe('v2.1 tokens', () => {
  it('issues with a valid RS256 JWT assertion', async () => {
    const clock = new ManualClock();
    const p = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    expect(await p.getToken()).toBe('tok-1');

    const form = issued[0]!.form;
    expect(form.grant_type).toBe('client_credentials');
    expect(form.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const [h, pl, sig] = form.client_assertion!.split('.') as [string, string, string];
    expect(verify('sha256', Buffer.from(`${h}.${pl}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'my-kid' });
    const nowS = Math.floor(clock.now().getTime() / 1000);
    expect(JSON.parse(Buffer.from(pl, 'base64url').toString())).toEqual({
      iss: '1234567890',
      sub: '1234567890',
      aud: 'https://api.line.me/',
      exp: nowS + 1800,
      token_exp: 2592000,
    });
    expect(p.status()).toEqual({ mode: 'v21', expiresAt: new Date(clock.now().getTime() + expiresIn * 1000) });
  });

  it('persists the token encrypted and a second instance reuses it', async () => {
    const clock = new ManualClock();
    const first = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    const token = await first.getToken();

    const { rows } = await db.query<{ value: { token: string; keyId: string; expiresAt: string } }>(
      "select value from system_state where key = 'line_access_token'",
    );
    const stored = rows[0]!.value;
    expect(stored.keyId).toBe('kid-1');
    expect(stored.token).not.toContain(token);
    expect(Buffer.from(stored.token, 'base64').toString('latin1')).not.toContain(token);

    const second = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    expect(await second.getToken()).toBe(token);
    expect(issued).toHaveLength(1);
  });

  it('ignores a stored token that cannot be decrypted with the current channel secret', async () => {
    const clock = new ManualClock();
    await createTokenProvider({ config: v21Config(), db, clock, log, limiter }).getToken();
    const rotated = config({
      LINE_TOKEN_MODE: 'v21',
      LINE_JWK_PRIVATE_KEY: privateJwk,
      LINE_JWK_KID: 'my-kid',
      LINE_CHANNEL_SECRET: 'rotated-secret',
    });
    expect(await createTokenProvider({ config: rotated, db, clock, log, limiter }).getToken()).toBe('tok-2');
  });

  it('renews once 80 % of the lifetime has elapsed', async () => {
    expiresIn = 1000;
    const clock = new ManualClock();
    const p = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    expect(await p.getToken()).toBe('tok-1');
    clock.advance(799_000);
    expect(await p.getToken()).toBe('tok-1');
    clock.advance(2_000);
    expect(await p.getToken()).toBe('tok-2');
    // Another process picks up the renewed token from the database.
    const other = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    expect(await other.getToken()).toBe('tok-2');
    expect(issued).toHaveLength(2);
  });

  it('shares one in-flight issuance between concurrent callers', async () => {
    const clock = new ManualClock();
    const p = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => p.getToken()));
    expect(new Set(tokens)).toEqual(new Set(['tok-1']));
    expect(issued).toHaveLength(1);
  });

  it('re-issues after invalidate even though the stored token is still fresh', async () => {
    const clock = new ManualClock();
    const p = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    await p.getToken();
    p.invalidate();
    expect(await p.getToken()).toBe('tok-2');
    expect(await p.getToken()).toBe('tok-2');
  });

  it('keeps using a still-valid token when renewal fails, and fails once none is valid', async () => {
    expiresIn = 1000;
    const clock = new ManualClock();
    const p = createTokenProvider({ config: v21Config(), db, clock, log, limiter });
    await p.getToken();
    failIssue = true;
    clock.advance(900_000);
    expect(await p.getToken()).toBe('tok-1');
    clock.advance(200_000);
    const err = await p.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineApiError);
    expect((err as LineApiError).status).toBe(400);
    expect((err as LineApiError).message).toBe('bad assertion');
  });
});

describe('stateless tokens', () => {
  it('issues with the client secret and renews after 10 minutes', async () => {
    expiresIn = 900;
    const clock = new ManualClock();
    const p = createTokenProvider({ config: config({ LINE_TOKEN_MODE: 'stateless' }), db, clock, log, limiter });
    expect(await p.getToken()).toBe('tok-1');
    expect(issued[0]!.path).toBe('/oauth2/v3/token');
    expect(issued[0]!.form).toMatchObject({
      grant_type: 'client_credentials',
      client_id: '1234567890',
      client_secret: 'channel-secret',
    });
    clock.advance(9 * 60_000);
    expect(await p.getToken()).toBe('tok-1');
    clock.advance(61_000);
    expect(await p.getToken()).toBe('tok-2');
    p.invalidate();
    expect(await p.getToken()).toBe('tok-3');
    const { rows } = await db.query('select 1 from system_state');
    expect(rows).toHaveLength(0);
  });
});
