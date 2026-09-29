import type { Readable } from 'node:stream';
import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { systemClock, type Clock } from '../util/clock.js';
import {
  LineApiError,
  type BotInfo,
  type ContentResult,
  type GroupSummary,
  type LinePlatform,
  type MemberProfile,
  type PushOptions,
  type Quota,
  type SendResult,
  type SentMessage,
  type TranscodingStatus,
} from './adapter.js';
import type { RateLimiter } from './rateLimiter.js';
import type { TokenProvider } from './tokens.js';
import type { OutboundMessage } from './types.js';

export interface ApiCallEvent {
  endpoint: string;
  method: string;
  status: number;
  ms: number;
  requestId?: string;
}

interface HttpOutcome<T> {
  status: number;
  headers: Headers;
  value: T;
}

export interface CallSpec {
  /** Path template (no IDs), used for logs, metrics and errors. */
  endpoint: string;
  method: 'GET' | 'POST';
  timeoutMs?: number;
}

export interface CallDeps {
  log: Logger;
  clock?: Clock;
  onApiCall?: (e: ApiCallEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Runs one LINE HTTP call with a timeout, maps failures to `LineApiError` and emits exactly one
 * structured log line per call (FR-OPS-3). Bodies and tokens are never logged.
 */
export async function callLine<T>(
  deps: CallDeps,
  spec: CallSpec,
  fn: (signal: AbortSignal) => Promise<HttpOutcome<T>>,
): Promise<T> {
  const clock = deps.clock ?? systemClock;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = clock.now().getTime();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new LineApiError(`timeout after ${timeoutMs} ms`, 0, spec.endpoint));
    }, timeoutMs);
  });
  const attempt = fn(abort.signal);
  // The SDK cannot cancel its fetch; keep a late rejection of the losing promise from going unhandled.
  attempt.catch(() => undefined);

  let status = 0;
  let requestId: string | undefined;
  try {
    const out = await Promise.race([attempt, timeout]);
    status = out.status;
    requestId = out.headers.get('x-line-request-id') ?? undefined;
    return out.value;
  } catch (err) {
    const mapped = toLineApiError(err, spec.endpoint);
    status = mapped.status;
    requestId = mapped.requestId;
    throw mapped;
  } finally {
    clearTimeout(timer);
    const e: ApiCallEvent = { endpoint: spec.endpoint, method: spec.method, status, ms: clock.now().getTime() - started, requestId };
    deps.log.info(e, 'line api call');
    deps.onApiCall?.(e);
  }
}

function toLineApiError(err: unknown, endpoint: string): LineApiError {
  if (err instanceof LineApiError) return err;
  if (err instanceof HTTPFetchError) {
    const requestId = err.headers.get('x-line-request-id') ?? undefined;
    let message = err.message;
    let details: { message?: string; property?: string }[] = [];
    try {
      const body = JSON.parse(err.body) as {
        message?: unknown;
        error_description?: unknown;
        error?: unknown;
        details?: unknown;
      };
      const text = body.message ?? body.error_description ?? body.error;
      if (typeof text === 'string' && text) message = text;
      if (Array.isArray(body.details)) details = body.details as typeof details;
    } catch {
      // Non-JSON error bodies (proxies, gateways) keep the HTTP status line as the message.
    }
    return new LineApiError(message, err.status, endpoint, requestId, details, err.body);
  }
  // Network failures and malformed success bodies: the outcome is unknown, so retryable.
  return new LineApiError(err instanceof Error ? err.message : String(err), 0, endpoint);
}

function outcome<T, V>(r: { httpResponse: Response; body: T }, value: V): HttpOutcome<V> {
  return { status: r.httpResponse.status, headers: r.httpResponse.headers, value };
}

async function readLimited(body: Readable, maxBytes: number, endpoint: string, signal: AbortSignal): Promise<Buffer> {
  const onAbort = () => body.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw new LineApiError('content too large', 413, endpoint);
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    body.destroy();
  }
  return Buffer.concat(chunks, total);
}

interface Clients {
  api: messagingApi.MessagingApiClient;
  blob: messagingApi.MessagingApiBlobClient;
}

export interface SdkLineClientOptions {
  config: Config;
  tokens: TokenProvider;
  limiter: RateLimiter;
  log: Logger;
  clock?: Clock;
  timeoutMs?: number;
  contentTimeoutMs?: number;
  onApiCall?: (e: ApiCallEvent) => void;
}

/**
 * `LinePlatform` over the official SDK. Deliberately exposes no broadcast, multicast or
 * narrowcast operation (NFR-SEC-5).
 */
export class SdkLineClient implements LinePlatform {
  private readonly config: Config;
  private readonly tokens: TokenProvider;
  private readonly limiter: RateLimiter;
  private readonly deps: CallDeps;
  private readonly timeoutMs: number;
  private readonly contentTimeoutMs: number;
  private token: string | null = null;
  private clients: Clients | null = null;

  constructor(opts: SdkLineClientOptions) {
    this.config = opts.config;
    this.tokens = opts.tokens;
    this.limiter = opts.limiter;
    this.deps = { log: opts.log, clock: opts.clock, onApiCall: opts.onApiCall };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.contentTimeoutMs = opts.contentTimeoutMs ?? 120_000;
  }

  private async call<T>(
    spec: CallSpec & { host: 'api' | 'data' },
    fn: (c: Clients, signal: AbortSignal) => Promise<HttpOutcome<T>>,
  ): Promise<T> {
    await this.limiter.acquire(spec.host);
    const token = await this.tokens.getToken();
    if (token !== this.token || !this.clients) {
      this.clients = {
        api: new messagingApi.MessagingApiClient({ baseURL: this.config.LINE_API_BASE, channelAccessToken: token }),
        blob: new messagingApi.MessagingApiBlobClient({ baseURL: this.config.LINE_API_DATA_BASE, channelAccessToken: token }),
      };
      this.token = token;
    }
    const clients = this.clients;
    try {
      return await callLine(this.deps, { timeoutMs: this.timeoutMs, ...spec }, (signal) => fn(clients, signal));
    } catch (err) {
      if (err instanceof LineApiError && err.status === 401) this.tokens.invalidate();
      throw err;
    }
  }

  push(to: string, messages: OutboundMessage[], opts: PushOptions): Promise<SendResult> {
    const endpoint = '/v2/bot/message/push';
    return this.call({ endpoint, method: 'POST', host: 'api' }, async ({ api }): Promise<HttpOutcome<SendResult>> => {
      try {
        const r = await api.pushMessageWithHttpInfo(
          { to, messages, notificationDisabled: opts.notificationDisabled ?? false },
          opts.retryKey,
        );
        return outcome(r, {
          status: 200 as const,
          sentMessages: r.body.sentMessages ?? [],
          requestId: r.httpResponse.headers.get('x-line-request-id') ?? undefined,
        });
      } catch (err) {
        // 409: this retry key was already accepted; LINE returns the original sentMessages.
        if (!(err instanceof HTTPFetchError) || err.status !== 409) throw err;
        let sentMessages: SentMessage[] = [];
        try {
          const body = JSON.parse(err.body) as { sentMessages?: unknown };
          if (Array.isArray(body.sentMessages)) sentMessages = body.sentMessages as SentMessage[];
        } catch {
          // An unparseable 409 still means "already sent"; the relay map just lacks the IDs.
        }
        return {
          status: 409,
          headers: err.headers,
          value: {
            status: 409 as const,
            sentMessages,
            requestId: err.headers.get('x-line-request-id') ?? undefined,
            acceptedRequestId: err.headers.get('x-line-accepted-request-id') ?? undefined,
          },
        };
      }
    });
  }

  reply(replyToken: string, messages: OutboundMessage[], opts: { notificationDisabled?: boolean } = {}): Promise<SendResult> {
    return this.call({ endpoint: '/v2/bot/message/reply', method: 'POST', host: 'api' }, async ({ api }) => {
      const r = await api.replyMessageWithHttpInfo({
        replyToken,
        messages,
        notificationDisabled: opts.notificationDisabled ?? false,
      });
      return outcome(r, {
        status: 200 as const,
        sentMessages: r.body.sentMessages ?? [],
        requestId: r.httpResponse.headers.get('x-line-request-id') ?? undefined,
      });
    });
  }

  validatePush(messages: OutboundMessage[]): Promise<void> {
    return this.call({ endpoint: '/v2/bot/message/validate/push', method: 'POST', host: 'api' }, async ({ api }) =>
      outcome(await api.validatePushWithHttpInfo({ messages }), undefined),
    );
  }

  getGroupSummary(groupId: string): Promise<GroupSummary> {
    return this.call({ endpoint: '/v2/bot/group/{groupId}/summary', method: 'GET', host: 'api' }, async ({ api }) => {
      const r = await api.getGroupSummaryWithHttpInfo(groupId);
      return outcome(r, { groupId: r.body.groupId, groupName: r.body.groupName, pictureUrl: r.body.pictureUrl });
    });
  }

  getGroupMemberCount(groupId: string): Promise<number> {
    return this.call({ endpoint: '/v2/bot/group/{groupId}/members/count', method: 'GET', host: 'api' }, async ({ api }) => {
      const r = await api.getGroupMemberCountWithHttpInfo(groupId);
      return outcome(r, r.body.count);
    });
  }

  async getGroupMemberProfile(groupId: string, userId: string): Promise<MemberProfile | null> {
    try {
      return await this.call(
        { endpoint: '/v2/bot/group/{groupId}/member/{userId}', method: 'GET', host: 'api' },
        async ({ api }) => {
          const r = await api.getGroupMemberProfileWithHttpInfo(groupId, userId);
          return outcome(r, { userId: r.body.userId, displayName: r.body.displayName, pictureUrl: r.body.pictureUrl });
        },
      );
    } catch (err) {
      if (err instanceof LineApiError && err.status === 404) return null;
      throw err;
    }
  }

  leaveGroup(groupId: string): Promise<void> {
    return this.call({ endpoint: '/v2/bot/group/{groupId}/leave', method: 'POST', host: 'api' }, async ({ api }) =>
      outcome(await api.leaveGroupWithHttpInfo(groupId), undefined),
    );
  }

  getBotInfo(): Promise<BotInfo> {
    return this.call({ endpoint: '/v2/bot/info', method: 'GET', host: 'api' }, async ({ api }) => {
      const r = await api.getBotInfoWithHttpInfo();
      const b = r.body;
      return outcome(r, {
        userId: b.userId,
        basicId: b.basicId,
        displayName: b.displayName,
        pictureUrl: b.pictureUrl,
        chatMode: b.chatMode,
        markAsReadMode: b.markAsReadMode,
      });
    });
  }

  getQuota(): Promise<Quota> {
    return this.call({ endpoint: '/v2/bot/message/quota', method: 'GET', host: 'api' }, async ({ api }) => {
      const r = await api.getMessageQuotaWithHttpInfo();
      return outcome(r, { type: r.body.type, value: r.body.value });
    });
  }

  getQuotaConsumption(): Promise<{ totalUsage: number }> {
    return this.call({ endpoint: '/v2/bot/message/quota/consumption', method: 'GET', host: 'api' }, async ({ api }) => {
      const r = await api.getMessageQuotaConsumptionWithHttpInfo();
      return outcome(r, { totalUsage: r.body.totalUsage });
    });
  }

  getContent(messageId: string, maxBytes: number): Promise<ContentResult> {
    const endpoint = '/v2/bot/message/{messageId}/content';
    return this.call(
      { endpoint, method: 'GET', host: 'data', timeoutMs: this.contentTimeoutMs },
      async ({ blob }, signal): Promise<HttpOutcome<ContentResult>> => {
        const r = await blob.getMessageContentWithHttpInfo(messageId);
        const { status, headers } = r.httpResponse;
        if (status === 202) {
          r.body.destroy();
          return outcome(r, { status: 'preparing' });
        }
        const declared = Number(headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          r.body.destroy();
          throw new LineApiError('content too large', 413, endpoint, headers.get('x-line-request-id') ?? undefined);
        }
        const data = await readLimited(r.body, maxBytes, endpoint, signal);
        return outcome(r, {
          status: 'ready',
          contentType: headers.get('content-type') ?? 'application/octet-stream',
          data,
        });
      },
    );
  }

  async getContentPreview(messageId: string): Promise<{ contentType: string; data: Buffer } | null> {
    try {
      return await this.call(
        { endpoint: '/v2/bot/message/{messageId}/content/preview', method: 'GET', host: 'data', timeoutMs: this.contentTimeoutMs },
        async ({ blob }, signal) => {
          const r = await blob.getMessageContentPreviewWithHttpInfo(messageId);
          const { status, headers } = r.httpResponse;
          if (status !== 200) {
            r.body.destroy();
            return outcome(r, null);
          }
          const data = await readLimited(r.body, Number.POSITIVE_INFINITY, '/v2/bot/message/{messageId}/content/preview', signal);
          return outcome(r, { contentType: headers.get('content-type') ?? 'application/octet-stream', data });
        },
      );
    } catch (err) {
      if (err instanceof LineApiError && err.status === 404) return null;
      throw err;
    }
  }

  getTranscodingStatus(messageId: string): Promise<TranscodingStatus> {
    return this.call(
      { endpoint: '/v2/bot/message/{messageId}/content/transcoding', method: 'GET', host: 'data' },
      async ({ blob }) => {
        const r = await blob.getMessageContentTranscodingByMessageIdWithHttpInfo(messageId);
        return outcome(r, r.body.status);
      },
    );
  }
}
