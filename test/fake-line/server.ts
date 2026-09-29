// In-repo stand-in for the LINE Platform. LINE forbids load and bulk operation
// testing against the real API, so integration, chaos and load tests run here.
// The api host and the api-data host paths are served by the same server so both
// base URLs can point at it.

import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { postWebhook, leaveEvent } from './webhook.js';
import type { LineEvent } from '../../src/line/types.js';

export type FakeEndpoint =
  | 'push'
  | 'reply'
  | 'validate'
  | 'quota'
  | 'consumption'
  | 'summary'
  | 'membersCount'
  | 'member'
  | 'leave'
  | 'info'
  | 'content'
  | 'preview'
  | 'transcoding'
  | 'token';

export interface FakeMember {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

export interface FakeGroupInput {
  groupId: string;
  name: string;
  pictureUrl?: string;
  members: FakeMember[];
}

export interface FakeContent {
  contentType: string;
  data: Buffer;
  preview?: Buffer;
  /** Defaults to image/jpeg. */
  previewContentType?: string;
  /** Number of `/content/transcoding` polls answering `processing` before `succeeded`. */
  transcodePolls?: number;
  failTranscode?: boolean;
  /** Content deleted by LINE: every content endpoint answers 410. */
  expired?: boolean;
}

export interface FakeFailure {
  endpoint: FakeEndpoint | '*';
  status: number;
  message?: string;
  /** How many matching requests fail before the endpoint recovers. Default 1. */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  status: number;
  at: number;
}

export interface SentMessage {
  id: string;
  quoteToken?: string;
}

export interface Delivery {
  via: 'push' | 'reply';
  messages: Record<string, unknown>[];
  sentMessages: SentMessage[];
  retryKey?: string;
  notificationDisabled?: boolean;
  at: number;
}

export interface ValidationDetail {
  message: string;
  property: string;
}

export interface FakeLineOptions {
  channelSecret?: string;
  botUserId?: string;
  replyTokenTtlMs?: number;
  now?: () => number;
  monthlyLimit?: number | null;
  /** Where `emit()` and the bot-leave side effect post signed webhooks. */
  webhookUrl?: string;
  host?: string;
  port?: number;
  /** Keeps only the newest N recorded requests and deliveries per group (long load runs). */
  recordLimit?: number;
}

export interface FakeLine {
  readonly url: string;
  readonly channelSecret: string;
  readonly botUserId: string;
  readonly requests: RecordedRequest[];
  /** Per-recipient billed message count per group (push only). */
  readonly billed: Record<string, number>;
  /** Total usage as reported by `/quota/consumption`. */
  readonly consumption: number;
  close(): Promise<void>;
  addGroup(group: FakeGroupInput): void;
  addMember(groupId: string, member: FakeMember): void;
  removeMember(groupId: string, userId: string): void;
  setBotInGroup(groupId: string, inGroup: boolean): void;
  setContent(messageId: string, content: FakeContent): void;
  setQuota(quota: { type: 'none' | 'limited'; value?: number }): void;
  setConsumption(totalUsage: number): void;
  setMonthlyLimitReached(reached: boolean): void;
  injectFailure(failure: FakeFailure): void;
  /** Delays responses (all endpoints, or one) to simulate slow LINE / client timeouts. */
  setDelay(ms: number, endpoint?: FakeEndpoint): void;
  issueReplyToken(groupId: string): string;
  registerReplyToken(token: string, groupId: string): void;
  registerQuoteToken(token: string, groupId: string): void;
  delivered(groupId: string): Delivery[];
  /** Signs and posts a webhook to `webhookUrl`; returns the HTTP status. */
  emit(events: LineEvent[], opts?: { redelivery?: boolean }): Promise<number>;
}

interface GroupState {
  groupId: string;
  name: string;
  pictureUrl?: string;
  members: Map<string, FakeMember>;
  botInGroup: boolean;
}

interface ContentState extends FakeContent {
  pollsLeft: number;
}

interface RetryRecord {
  requestId: string;
  acceptedAt: number;
  sentMessages: SentMessage[];
}

const RETRY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_TYPES = ['text', 'textV2', 'sticker', 'image', 'video', 'audio', 'location'];
const QUOTE_TOKEN_TYPES = new Set(['text', 'textV2', 'sticker', 'image', 'video']);
const QUOTABLE_TYPES = new Set(['text', 'textV2', 'sticker']);
const MONTHLY_LIMIT_MESSAGE = 'You have reached your monthly limit.';
const AUTH_FAILED_MESSAGE = 'Authentication failed. Confirm that the access token in the authorization header is valid.';
const INVALID_TO_MESSAGE = "The property, 'to', in the request body is invalid (line: -, column: -)";
const MAX_URL = 2000;

declare module 'fastify' {
  interface FastifyContextConfig {
    endpoint?: FakeEndpoint;
    control?: boolean;
  }
  interface FastifyRequest {
    lineRequestId: string;
    receivedAt: number;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_URL) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function lineError(message: string, details: ValidationDetail[] = []): Record<string, unknown> {
  return details.length > 0 ? { message, details } : { message };
}

function validationError(details: ValidationDetail[]): Record<string, unknown> {
  return lineError(`The request body has ${details.length} error(s)`, details);
}

function defaultFailureMessage(status: number): string {
  if (status === 429) return 'Too many requests';
  if (status === 400) return 'The request body has 1 error(s)';
  if (status === 401) return AUTH_FAILED_MESSAGE;
  if (status >= 500) return 'Internal server error';
  return 'Request failed';
}

function capped<T>(list: T[], item: T, limit: number | undefined): void {
  list.push(item);
  if (limit !== undefined && list.length > limit) list.splice(0, list.length - limit);
}

interface ValidateContext {
  /** Target group for push/reply; absent on the validate endpoints, which can't check scoping or membership. */
  group?: GroupState;
  quoteTokens: Map<string, string>;
}

function validateText(m: Record<string, unknown>, p: string, details: ValidationDetail[]): string | undefined {
  const text = m.text;
  if (!nonEmptyString(text)) {
    details.push({ message: 'May not be empty', property: `${p}.text` });
    return undefined;
  }
  if (text.length > 5000) details.push({ message: 'Length must be between 1 and 5000', property: `${p}.text` });
  return text;
}

function validateEmojis(m: Record<string, unknown>, text: string, p: string, details: ValidationDetail[]): void {
  if (m.emojis === undefined) return;
  if (!Array.isArray(m.emojis)) {
    details.push({ message: 'Must be an array', property: `${p}.emojis` });
    return;
  }
  if (m.emojis.length > 20) details.push({ message: 'Size must be between 0 and 20', property: `${p}.emojis` });
  const seen = new Set<number>();
  m.emojis.forEach((raw, j) => {
    const e = asRecord(raw);
    const ep = `${p}.emojis[${j}]`;
    if (!e) {
      details.push({ message: 'Must be an object', property: ep });
      return;
    }
    const index = e.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || text[index] !== '$' || seen.has(index)) {
      details.push({ message: "Must point at a '$' placeholder in text", property: `${ep}.index` });
    } else {
      seen.add(index);
    }
    if (!nonEmptyString(e.productId)) details.push({ message: 'May not be empty', property: `${ep}.productId` });
    if (!nonEmptyString(e.emojiId)) details.push({ message: 'May not be empty', property: `${ep}.emojiId` });
  });
}

function validateSubstitution(m: Record<string, unknown>, p: string, ctx: ValidateContext, details: ValidationDetail[]): void {
  if (m.substitution === undefined) return;
  const sub = asRecord(m.substitution);
  if (!sub) {
    details.push({ message: 'Must be an object', property: `${p}.substitution` });
    return;
  }
  const entries = Object.entries(sub);
  if (entries.length > 100) details.push({ message: 'Size must be between 0 and 100', property: `${p}.substitution` });
  let mentions = 0;
  let emojis = 0;
  for (const [key, raw] of entries) {
    const sp = `${p}.substitution.${key}`;
    const s = asRecord(raw);
    if (!/^[a-zA-Z0-9_]{1,20}$/.test(key) || !s) {
      details.push({ message: 'Invalid substitution', property: sp });
      continue;
    }
    if (s.type === 'emoji') {
      emojis++;
      if (!nonEmptyString(s.productId) || !nonEmptyString(s.emojiId)) {
        details.push({ message: 'May not be empty', property: sp });
      }
    } else if (s.type === 'mention') {
      mentions++;
      const target = asRecord(s.mentionee);
      if (target?.type === 'user' && nonEmptyString(target.userId)) {
        if (ctx.group && !ctx.group.members.has(target.userId)) {
          details.push({ message: 'The mentioned user is not a member of the chat', property: `${sp}.mentionee.userId` });
        }
      } else if (target?.type !== 'all') {
        details.push({ message: 'Invalid mentionee', property: `${sp}.mentionee` });
      }
    } else {
      details.push({ message: 'Must be one of the following values: [mention, emoji]', property: `${sp}.type` });
    }
  }
  if (mentions > 20) details.push({ message: 'Too many mentions (max 20)', property: `${p}.substitution` });
  if (emojis > 20) details.push({ message: 'Too many emojis (max 20)', property: `${p}.substitution` });
}

function validateSender(m: Record<string, unknown>, p: string, details: ValidationDetail[]): void {
  if (m.sender === undefined) return;
  const sender = asRecord(m.sender);
  if (!sender) {
    details.push({ message: 'Must be an object', property: `${p}.sender` });
    return;
  }
  const { name, iconUrl } = sender;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length < 1 || name.length > 20) {
      details.push({ message: 'Length must be between 1 and 20', property: `${p}.sender.name` });
    } else if (name.normalize('NFKC').toUpperCase().includes('LINE')) {
      details.push({ message: 'Contains a forbidden word', property: `${p}.sender.name` });
    }
  }
  if (iconUrl !== undefined) {
    let png = false;
    if (isHttpsUrl(iconUrl)) png = new URL(iconUrl).pathname.toLowerCase().endsWith('.png');
    if (!png) details.push({ message: 'Must be an HTTPS URL of a PNG image', property: `${p}.sender.iconUrl` });
  }
}

function validateQuoteToken(m: Record<string, unknown>, type: string, p: string, ctx: ValidateContext, details: ValidationDetail[]): void {
  const token = m.quoteToken;
  if (token === undefined) return;
  const prop = `${p}.quoteToken`;
  if (!QUOTABLE_TYPES.has(type)) {
    details.push({ message: 'Not supported for this message type', property: prop });
  } else if (!nonEmptyString(token)) {
    details.push({ message: 'May not be empty', property: prop });
  } else if (ctx.group && ctx.quoteTokens.get(token) !== ctx.group.groupId) {
    details.push({ message: 'Invalid quote token', property: prop });
  }
}

function validateMessages(messages: unknown, ctx: ValidateContext): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 5) {
    return [{ message: 'Size must be between 1 and 5', property: 'messages' }];
  }
  messages.forEach((raw, i) => {
    const p = `messages[${i}]`;
    const m = asRecord(raw);
    if (!m) {
      details.push({ message: 'Must be an object', property: p });
      return;
    }
    const type = typeof m.type === 'string' ? m.type : '';
    switch (type) {
      case 'text': {
        const text = validateText(m, p, details);
        if (text !== undefined) validateEmojis(m, text, p, details);
        break;
      }
      case 'textV2':
        validateText(m, p, details);
        validateSubstitution(m, p, ctx, details);
        break;
      case 'sticker':
        if (!nonEmptyString(m.packageId)) details.push({ message: 'May not be empty', property: `${p}.packageId` });
        if (!nonEmptyString(m.stickerId)) details.push({ message: 'May not be empty', property: `${p}.stickerId` });
        break;
      case 'image':
      case 'video':
        if (!isHttpsUrl(m.originalContentUrl)) details.push({ message: 'Must be an HTTPS URL', property: `${p}.originalContentUrl` });
        if (!isHttpsUrl(m.previewImageUrl)) details.push({ message: 'Must be an HTTPS URL', property: `${p}.previewImageUrl` });
        if (type === 'video' && m.trackingId !== undefined && ctx.group) {
          details.push({ message: 'trackingId is not allowed for group chats', property: `${p}.trackingId` });
        }
        break;
      case 'audio':
        if (!isHttpsUrl(m.originalContentUrl)) details.push({ message: 'Must be an HTTPS URL', property: `${p}.originalContentUrl` });
        if (typeof m.duration !== 'number' || !Number.isInteger(m.duration) || m.duration <= 0) {
          details.push({ message: 'Must be a positive integer', property: `${p}.duration` });
        }
        break;
      case 'location':
        for (const f of ['title', 'address'] as const) {
          const v = m[f];
          if (!nonEmptyString(v) || v.length > 100) details.push({ message: 'Length must be between 1 and 100', property: `${p}.${f}` });
        }
        for (const f of ['latitude', 'longitude'] as const) {
          if (typeof m[f] !== 'number' || !Number.isFinite(m[f])) details.push({ message: 'Must be a number', property: `${p}.${f}` });
        }
        break;
      default:
        details.push({ message: `Must be one of the following values: [${KNOWN_TYPES.join(', ')}]`, property: `${p}.type` });
        return;
    }
    validateQuoteToken(m, type, p, ctx, details);
    validateSender(m, p, details);
  });
  return details;
}

export async function createFakeLine(opts: FakeLineOptions = {}): Promise<FakeLine> {
  const channelSecret = opts.channelSecret ?? 'fake-channel-secret';
  const botUserId = opts.botUserId ?? 'U00000000000000000000000000000b07';
  const replyTokenTtlMs = opts.replyTokenTtlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const recordLimit = opts.recordLimit;

  const groups = new Map<string, GroupState>();
  const replyTokens = new Map<string, { groupId: string; issuedAt: number; used: boolean }>();
  const quoteTokens = new Map<string, string>();
  const retryKeys = new Map<string, RetryRecord>();
  const contents = new Map<string, ContentState>();
  const deliveries = new Map<string, Delivery[]>();
  const failures: Required<FakeFailure>[] = [];
  const delays = new Map<FakeEndpoint | '*', number>();
  const pendingDelays = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  const requests: RecordedRequest[] = [];
  const billed: Record<string, number> = {};
  let consumption = 0;
  let monthlyLimitFlag = false;
  let quota: { type: 'none' | 'limited'; value?: number } =
    opts.monthlyLimit != null ? { type: 'limited', value: opts.monthlyLimit } : { type: 'none' };
  let nextMessageId = 600_000_000_000_000_000n;

  function requireGroup(groupId: string): GroupState {
    const g = groups.get(groupId);
    if (!g) throw new Error(`fake-line: unknown group ${groupId}`);
    return g;
  }

  function activeGroup(groupId: string): GroupState | undefined {
    const g = groups.get(groupId);
    return g?.botInGroup ? g : undefined;
  }

  function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const entry = {
      timer: setTimeout(() => {
        pendingDelays.delete(entry);
        resolve();
      }, ms),
      resolve,
    };
    pendingDelays.add(entry);
    return promise;
  }

  function takeFailure(endpoint: FakeEndpoint): Required<FakeFailure> | undefined {
    const idx = failures.findIndex((f) => f.endpoint === endpoint || f.endpoint === '*');
    if (idx < 0) return undefined;
    const f = failures[idx]!;
    f.times--;
    if (f.times <= 0) failures.splice(idx, 1);
    return f;
  }

  function deliver(groupId: string, d: Omit<Delivery, 'sentMessages'>): SentMessage[] {
    const sentMessages = d.messages.map((m): SentMessage => {
      const sent: SentMessage = { id: String(nextMessageId++) };
      if (QUOTE_TOKEN_TYPES.has(String(m.type))) {
        sent.quoteToken = randomBytes(24).toString('base64url');
        quoteTokens.set(sent.quoteToken, groupId);
      }
      return sent;
    });
    let list = deliveries.get(groupId);
    if (!list) deliveries.set(groupId, (list = []));
    capped(list, { ...d, sentMessages }, recordLimit);
    return sentMessages;
  }

  function contentFor(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): ContentState | undefined {
    const c = contents.get(req.params.id);
    if (!c) {
      void reply.code(404).send(lineError('Not found'));
      return undefined;
    }
    if (c.expired) {
      void reply.code(410).send(lineError('Gone'));
      return undefined;
    }
    return c;
  }

  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 50 * 1024 * 1024 });

  // The SDK posts `leave` with a JSON content type and no body, which Fastify's default parser rejects.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('The request body is not valid JSON'), { statusCode: 400 }));
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    done(null, Object.fromEntries(new URLSearchParams(text)));
  });

  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    void reply.code(err.statusCode ?? 500).send(lineError(err.message));
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(lineError('Not found'));
  });

  app.addHook('onRequest', async (req, reply) => {
    req.receivedAt = now();
    if (req.routeOptions.config.control) return;
    req.lineRequestId = randomBytes(16).toString('hex');
    void reply.header('x-line-request-id', req.lineRequestId);
    const endpoint = req.routeOptions.config.endpoint;
    const delay = (endpoint !== undefined ? delays.get(endpoint) : undefined) ?? delays.get('*') ?? 0;
    if (delay > 0) await sleep(delay);
  });

  app.addHook('preHandler', async (req, reply) => {
    const endpoint = req.routeOptions.config.endpoint;
    if (req.routeOptions.config.control || endpoint === undefined) return;
    if (endpoint !== 'token' && !/^Bearer\s+\S+/.test(req.headers.authorization ?? '')) {
      return reply.code(401).send(lineError(AUTH_FAILED_MESSAGE));
    }
    const failure = takeFailure(endpoint);
    if (failure) return reply.code(failure.status).send(lineError(failure.message));
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.routeOptions.config.control) return;
    capped(
      requests,
      {
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body: req.body,
        status: reply.statusCode,
        at: req.receivedAt,
      },
      recordLimit,
    );
  });

  const api = (endpoint: FakeEndpoint) => ({ config: { endpoint } });
  const control = { config: { control: true } };

  app.post('/v2/bot/message/push', api('push'), async (req, reply) => {
    const retryKey = req.headers['x-line-retry-key'];
    if (retryKey !== undefined) {
      if (typeof retryKey !== 'string' || !UUID_RE.test(retryKey)) {
        return reply.code(400).send(lineError('The value of X-Line-Retry-Key header is invalid'));
      }
      const prior = retryKeys.get(retryKey.toLowerCase());
      if (prior && now() - prior.acceptedAt < RETRY_KEY_TTL_MS) {
        return reply
          .code(409)
          .header('x-line-accepted-request-id', prior.requestId)
          .send({ message: 'The retry key is already accepted', sentMessages: prior.sentMessages });
      }
    }
    const body = asRecord(req.body);
    if (!body) return reply.code(400).send(validationError([{ message: 'May not be empty', property: 'body' }]));
    const group = typeof body.to === 'string' ? activeGroup(body.to) : undefined;
    if (!group) return reply.code(400).send(lineError(INVALID_TO_MESSAGE));
    const details = validateMessages(body.messages, { group, quoteTokens });
    if (details.length > 0) return reply.code(400).send(validationError(details));
    if (monthlyLimitFlag || (opts.monthlyLimit != null && consumption >= opts.monthlyLimit)) {
      return reply.code(429).send(lineError(MONTHLY_LIMIT_MESSAGE));
    }
    const sentMessages = deliver(group.groupId, {
      via: 'push',
      messages: body.messages as Record<string, unknown>[],
      retryKey: typeof retryKey === 'string' ? retryKey : undefined,
      notificationDisabled: body.notificationDisabled === true,
      at: now(),
    });
    const cost = group.members.size;
    billed[group.groupId] = (billed[group.groupId] ?? 0) + cost;
    consumption += cost;
    if (typeof retryKey === 'string') {
      retryKeys.set(retryKey.toLowerCase(), { requestId: req.lineRequestId, acceptedAt: now(), sentMessages });
    }
    return { sentMessages };
  });

  app.post('/v2/bot/message/reply', api('reply'), async (req, reply) => {
    if (req.headers['x-line-retry-key'] !== undefined) {
      return reply.code(400).send(lineError('X-Line-Retry-Key is not supported for this endpoint'));
    }
    const body = asRecord(req.body);
    const token = body && typeof body.replyToken === 'string' ? replyTokens.get(body.replyToken) : undefined;
    const group = token ? activeGroup(token.groupId) : undefined;
    if (!body || !token || !group || token.used || now() - token.issuedAt > replyTokenTtlMs) {
      return reply.code(400).send(lineError('Invalid reply token'));
    }
    const details = validateMessages(body.messages, { group, quoteTokens });
    if (details.length > 0) return reply.code(400).send(validationError(details));
    token.used = true;
    const sentMessages = deliver(group.groupId, {
      via: 'reply',
      messages: body.messages as Record<string, unknown>[],
      notificationDisabled: body.notificationDisabled === true,
      at: now(),
    });
    return { sentMessages };
  });

  for (const kind of ['push', 'reply'] as const) {
    app.post(`/v2/bot/message/validate/${kind}`, api('validate'), async (req, reply) => {
      const details = validateMessages(asRecord(req.body)?.messages, { quoteTokens });
      if (details.length > 0) return reply.code(400).send(validationError(details));
      return {};
    });
  }

  app.get('/v2/bot/message/quota', api('quota'), async () => quota);
  app.get('/v2/bot/message/quota/consumption', api('consumption'), async () => ({ totalUsage: consumption }));

  type GroupReq = FastifyRequest<{ Params: { id: string } }>;
  app.get('/v2/bot/group/:id/summary', api('summary'), async (req: GroupReq, reply) => {
    const g = activeGroup(req.params.id);
    if (!g) return reply.code(404).send(lineError('Not found'));
    return { groupId: g.groupId, groupName: g.name, ...(g.pictureUrl ? { pictureUrl: g.pictureUrl } : {}) };
  });
  app.get('/v2/bot/group/:id/members/count', api('membersCount'), async (req: GroupReq, reply) => {
    const g = activeGroup(req.params.id);
    if (!g) return reply.code(404).send(lineError('Not found'));
    return { count: g.members.size };
  });
  app.get(
    '/v2/bot/group/:id/member/:uid',
    api('member'),
    async (req: FastifyRequest<{ Params: { id: string; uid: string } }>, reply) => {
      const m = activeGroup(req.params.id)?.members.get(req.params.uid);
      if (!m) return reply.code(404).send(lineError('Not found'));
      return { userId: m.userId, displayName: m.displayName, ...(m.pictureUrl ? { pictureUrl: m.pictureUrl } : {}) };
    },
  );
  app.post('/v2/bot/group/:id/leave', api('leave'), async (req: GroupReq, reply) => {
    const g = activeGroup(req.params.id);
    if (!g) return reply.code(404).send(lineError('Not found'));
    g.botInGroup = false;
    if (opts.webhookUrl) {
      // LINE also sends a `leave` webhook when the bot leaves on its own.
      void fake.emit([leaveEvent({ groupId: g.groupId })]).catch(() => undefined);
    }
    return {};
  });

  app.get('/v2/bot/info', api('info'), async () => ({
    userId: botUserId,
    basicId: '@fakebot',
    displayName: 'Fake Bridge Bot',
    chatMode: 'bot',
    markAsReadMode: 'auto',
  }));

  app.get('/v2/bot/message/:id/content', api('content'), async (req: GroupReq, reply) => {
    const c = contentFor(req, reply);
    if (!c) return reply;
    if (c.failTranscode || c.pollsLeft > 0) return reply.code(202).send();
    return reply.type(c.contentType).send(c.data);
  });
  app.get('/v2/bot/message/:id/content/preview', api('preview'), async (req: GroupReq, reply) => {
    const c = contentFor(req, reply);
    if (!c) return reply;
    if (!c.preview) return reply.code(404).send(lineError('Not found'));
    return reply.type(c.previewContentType ?? 'image/jpeg').send(c.preview);
  });
  app.get('/v2/bot/message/:id/content/transcoding', api('transcoding'), async (req: GroupReq, reply) => {
    const c = contentFor(req, reply);
    if (!c) return reply;
    if (c.failTranscode) return { status: 'failed' };
    if (c.pollsLeft > 0) {
      c.pollsLeft--;
      return { status: 'processing' };
    }
    return { status: 'succeeded' };
  });

  const dummyToken = (): string => randomBytes(32).toString('base64url');
  app.post('/oauth2/v2.1/token', api('token'), async () => ({
    access_token: dummyToken(),
    token_type: 'Bearer',
    expires_in: 2_592_000,
    key_id: randomUUID(),
  }));
  app.post('/oauth2/v3/token', api('token'), async () => ({
    access_token: dummyToken(),
    token_type: 'Bearer',
    expires_in: 900,
  }));
  app.post('/v2/oauth/accessToken', api('token'), async () => ({
    access_token: dummyToken(),
    token_type: 'Bearer',
    expires_in: 2_592_000,
  }));
  app.get('/oauth2/v2.1/tokens/kid', api('token'), async () => ({ kids: [] }));
  app.post('/oauth2/v2.1/revoke', api('token'), async () => ({}));
  app.post('/v2/oauth/revoke', api('token'), async () => ({}));

  // Control API: lets a standalone fake (CLI, load test) be set up and inspected over HTTP.
  app.post('/__fake/groups', control, async (req) => {
    fake.addGroup(req.body as FakeGroupInput);
    return {};
  });
  app.post('/__fake/groups/:id/members', control, async (req: GroupReq) => {
    fake.addMember(req.params.id, req.body as FakeMember);
    return {};
  });
  app.delete('/__fake/groups/:id/members/:uid', control, async (req: FastifyRequest<{ Params: { id: string; uid: string } }>) => {
    fake.removeMember(req.params.id, req.params.uid);
    return {};
  });
  app.post('/__fake/reply-tokens', control, async (req) => ({
    replyToken: fake.issueReplyToken(String(asRecord(req.body)?.groupId)),
  }));
  app.post('/__fake/content/:id', control, async (req: GroupReq) => {
    const b = req.body as Omit<FakeContent, 'data' | 'preview'> & { dataBase64: string; previewBase64?: string };
    fake.setContent(req.params.id, {
      ...b,
      data: Buffer.from(b.dataBase64, 'base64'),
      ...(b.previewBase64 !== undefined ? { preview: Buffer.from(b.previewBase64, 'base64') } : {}),
    });
    return {};
  });
  app.post('/__fake/quota', control, async (req) => {
    fake.setQuota(req.body as { type: 'none' | 'limited'; value?: number });
    return {};
  });
  app.post('/__fake/monthly-limit', control, async (req) => {
    fake.setMonthlyLimitReached(asRecord(req.body)?.reached === true);
    return {};
  });
  app.post('/__fake/failures', control, async (req) => {
    fake.injectFailure(req.body as FakeFailure);
    return {};
  });
  app.post('/__fake/delay', control, async (req) => {
    const b = req.body as { ms: number; endpoint?: FakeEndpoint };
    fake.setDelay(b.ms, b.endpoint);
    return {};
  });
  app.post('/__fake/emit', control, async (req) => {
    const b = req.body as { events: LineEvent[]; redelivery?: boolean };
    return { status: await fake.emit(b.events, { redelivery: b.redelivery === true }) };
  });
  app.get('/__fake/requests', control, async () => requests);
  app.get('/__fake/delivered/:id', control, async (req: GroupReq) => fake.delivered(req.params.id));
  app.get('/__fake/billed', control, async () => ({ billed, totalUsage: consumption }));

  await app.listen({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('fake-line: unexpected listen address');
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${host === '0.0.0.0' || host === '[::]' ? '127.0.0.1' : host}:${address.port}`;

  const fake: FakeLine = {
    url,
    channelSecret,
    botUserId,
    requests,
    billed,
    get consumption() {
      return consumption;
    },
    async close() {
      for (const d of pendingDelays) {
        clearTimeout(d.timer);
        d.resolve();
      }
      pendingDelays.clear();
      await app.close();
    },
    addGroup(g) {
      groups.set(g.groupId, {
        groupId: g.groupId,
        name: g.name,
        ...(g.pictureUrl !== undefined ? { pictureUrl: g.pictureUrl } : {}),
        members: new Map(g.members.map((m) => [m.userId, { ...m }])),
        botInGroup: true,
      });
    },
    addMember(groupId, member) {
      requireGroup(groupId).members.set(member.userId, { ...member });
    },
    removeMember(groupId, userId) {
      requireGroup(groupId).members.delete(userId);
    },
    setBotInGroup(groupId, inGroup) {
      requireGroup(groupId).botInGroup = inGroup;
    },
    setContent(messageId, content) {
      contents.set(messageId, { ...content, pollsLeft: content.transcodePolls ?? 0 });
    },
    setQuota(q) {
      quota = { ...q };
    },
    setConsumption(totalUsage) {
      consumption = totalUsage;
    },
    setMonthlyLimitReached(reached) {
      monthlyLimitFlag = reached;
    },
    injectFailure(f) {
      failures.push({ endpoint: f.endpoint, status: f.status, message: f.message ?? defaultFailureMessage(f.status), times: f.times ?? 1 });
    },
    setDelay(ms, endpoint) {
      delays.set(endpoint ?? '*', ms);
    },
    issueReplyToken(groupId) {
      const token = randomBytes(16).toString('hex');
      fake.registerReplyToken(token, groupId);
      return token;
    },
    registerReplyToken(token, groupId) {
      replyTokens.set(token, { groupId, issuedAt: now(), used: false });
    },
    registerQuoteToken(token, groupId) {
      quoteTokens.set(token, groupId);
    },
    delivered(groupId) {
      return deliveries.get(groupId) ?? [];
    },
    async emit(events, emitOpts = {}) {
      if (!opts.webhookUrl) throw new Error('fake-line: emit() needs the webhookUrl option');
      return postWebhook(opts.webhookUrl, channelSecret, { destination: botUserId, events }, emitOpts);
    },
  };
  return fake;
}
