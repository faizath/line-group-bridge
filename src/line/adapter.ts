// The only boundary through which the service talks to LINE (NFR-MAINT-2).
// Production uses the SDK-backed client; tests use the fake LINE server through
// the same client, or an in-memory implementation of this interface.

import type { OutboundMessage } from './types.js';

export interface SentMessage {
  id: string;
  quoteToken?: string;
}

export interface SendResult {
  /** 200 on first acceptance, 409 when the retry key was already accepted (treated as success). */
  status: 200 | 409;
  sentMessages: SentMessage[];
  requestId?: string;
  acceptedRequestId?: string;
}

export interface GroupSummary {
  groupId: string;
  groupName: string;
  pictureUrl?: string;
}

export interface MemberProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

export interface BotInfo {
  userId: string;
  basicId?: string;
  displayName: string;
  pictureUrl?: string;
  chatMode?: string;
  markAsReadMode?: string;
}

export interface Quota {
  type: 'none' | 'limited' | (string & {});
  value?: number;
}

export type ContentResult =
  | { status: 'ready'; contentType: string; data: Buffer }
  /** 202 from the content endpoint: LINE is still preparing (transcoding) the media. */
  | { status: 'preparing' };

export type TranscodingStatus = 'processing' | 'succeeded' | 'failed';

/**
 * Error from a LINE API call. `status` 0 means a network error or timeout (retryable).
 * `message` is LINE's error message (e.g. "You have reached your monthly limit.").
 */
export class LineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly requestId?: string,
    readonly details: { message?: string; property?: string }[] = [],
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LineApiError';
  }

  get isMonthlyLimit(): boolean {
    return this.status === 429 && /monthly limit/i.test(this.message);
  }

  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 401 || (this.status === 429 && !this.isMonthlyLimit);
  }
}

export interface PushOptions {
  retryKey: string;
  notificationDisabled?: boolean;
}

export interface LinePlatform {
  push(to: string, messages: OutboundMessage[], opts: PushOptions): Promise<SendResult>;
  reply(replyToken: string, messages: OutboundMessage[], opts?: { notificationDisabled?: boolean }): Promise<SendResult>;
  validatePush(messages: OutboundMessage[]): Promise<void>;
  getGroupSummary(groupId: string): Promise<GroupSummary>;
  getGroupMemberCount(groupId: string): Promise<number>;
  /** null when the user is not (or no longer) in the group (404). */
  getGroupMemberProfile(groupId: string, userId: string): Promise<MemberProfile | null>;
  leaveGroup(groupId: string): Promise<void>;
  getBotInfo(): Promise<BotInfo>;
  getQuota(): Promise<Quota>;
  getQuotaConsumption(): Promise<{ totalUsage: number }>;
  /** Throws LineApiError 404/410 when the content is gone. `maxBytes` aborts oversized downloads (413-like error). */
  getContent(messageId: string, maxBytes: number): Promise<ContentResult>;
  /** null when no preview is available. */
  getContentPreview(messageId: string): Promise<{ contentType: string; data: Buffer } | null>;
  getTranscodingStatus(messageId: string): Promise<TranscodingStatus>;
}
