// Builders for realistic LINE webhook events and a signed poster, so tests can
// drive the service's `/webhook` exactly like LINE does.

import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { LineEvent, WebhookBody } from '../../src/line/types.js';
import type { FakeLine } from './server.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Base64 HMAC-SHA256 of the raw body keyed with the channel secret (`x-line-signature`). */
export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** ULID: 48-bit millisecond time + 80 random bits, Crockford base32 (LINE's `webhookEventId` format). */
export function ulid(time = Date.now()): string {
  let head = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[randomInt(32)];
  return head + tail;
}

let messageSeq = BigInt(Date.now()) * 1000n;

/** Numeric message ID like LINE's (18 digits). */
export function messageId(): string {
  return String(messageSeq++);
}

export function replyToken(): string {
  return randomBytes(16).toString('hex');
}

export function quoteToken(): string {
  return randomBytes(24).toString('base64url');
}

interface Common {
  groupId: string;
  /** Omitted from `source` when absent, as for users who haven't consented. */
  userId?: string;
  timestamp?: number;
  fake?: FakeLine;
}

interface MessageCommon extends Common {
  id?: string;
}

export interface MentioneeInput {
  index: number;
  length: number;
  type?: 'user' | 'all';
  userId?: string;
  isSelf?: boolean;
}

export interface EmojiInput {
  index: number;
  length: number;
  productId: string;
  emojiId: string;
}

function baseEvent(type: string, c: Common): LineEvent {
  const timestamp = c.timestamp ?? Date.now();
  return {
    type,
    mode: 'active',
    timestamp,
    source: { type: 'group', groupId: c.groupId, ...(c.userId !== undefined ? { userId: c.userId } : {}) },
    webhookEventId: ulid(timestamp),
    deliveryContext: { isRedelivery: false },
  };
}

function withReplyToken(ev: LineEvent, c: Common): LineEvent {
  ev.replyToken = replyToken();
  c.fake?.registerReplyToken(ev.replyToken, c.groupId);
  return ev;
}

function messageEvent(c: MessageCommon, message: Record<string, unknown>, quotable: boolean, type = 'message'): LineEvent {
  const ev = withReplyToken(baseEvent(type, c), c);
  const id = c.id ?? messageId();
  ev.message = { id, type: String(message.type), ...message };
  if (quotable) {
    ev.message.quoteToken = quoteToken();
    c.fake?.registerQuoteToken(ev.message.quoteToken, c.groupId);
  }
  return ev;
}

function textFields(p: { text: string; emojis?: EmojiInput[]; mentionees?: MentioneeInput[] }): Record<string, unknown> {
  return {
    type: 'text',
    text: p.text,
    ...(p.emojis ? { emojis: p.emojis } : {}),
    ...(p.mentionees ? { mention: { mentionees: p.mentionees.map((m) => ({ type: 'user', ...m })) } } : {}),
  };
}

export function textEvent(
  p: MessageCommon & { text: string; emojis?: EmojiInput[]; mentionees?: MentioneeInput[]; quotedMessageId?: string },
): LineEvent {
  return messageEvent(
    p,
    {
      ...textFields(p),
      ...(p.quotedMessageId ? { quotedMessageId: p.quotedMessageId } : {}),
      markAsReadToken: randomBytes(12).toString('base64url'),
    },
    true,
  );
}

type ContentProviderInput = { type: 'line' } | { type: 'external'; originalContentUrl: string; previewImageUrl?: string };

export function imageEvent(
  p: MessageCommon & { contentProvider?: ContentProviderInput; imageSet?: { id: string; index?: number; total?: number } },
): LineEvent {
  return messageEvent(
    p,
    { type: 'image', contentProvider: p.contentProvider ?? { type: 'line' }, ...(p.imageSet ? { imageSet: p.imageSet } : {}) },
    true,
  );
}

/** Events for one multi-image send, returned in random order as LINE delivers them. */
export function imageSetEvents(p: Omit<MessageCommon, 'id'> & { count: number; setId?: string; ids?: string[] }): LineEvent[] {
  const setId = p.setId ?? randomBytes(16).toString('hex').toUpperCase();
  const events = Array.from({ length: p.count }, (_, i) =>
    imageEvent({ ...p, id: p.ids?.[i], imageSet: { id: setId, index: i + 1, total: p.count } }),
  );
  for (let i = events.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [events[i], events[j]] = [events[j]!, events[i]!];
  }
  return events;
}

export function videoEvent(p: MessageCommon & { duration?: number; contentProvider?: ContentProviderInput }): LineEvent {
  return messageEvent(p, { type: 'video', duration: p.duration ?? 10_000, contentProvider: p.contentProvider ?? { type: 'line' } }, true);
}

export function audioEvent(p: MessageCommon & { duration?: number; contentProvider?: ContentProviderInput }): LineEvent {
  return messageEvent(p, { type: 'audio', duration: p.duration ?? 5_000, contentProvider: p.contentProvider ?? { type: 'line' } }, false);
}

export function fileEvent(p: MessageCommon & { fileName: string; fileSize: number }): LineEvent {
  return messageEvent(p, { type: 'file', fileName: p.fileName, fileSize: p.fileSize }, false);
}

export function locationEvent(
  p: MessageCommon & { title?: string; address: string; latitude: number; longitude: number },
): LineEvent {
  return messageEvent(
    p,
    {
      type: 'location',
      ...(p.title !== undefined ? { title: p.title } : {}),
      address: p.address,
      latitude: p.latitude,
      longitude: p.longitude,
    },
    false,
  );
}

export function stickerEvent(
  p: MessageCommon & {
    packageId: string;
    stickerId: string;
    stickerResourceType?: string;
    keywords?: string[];
    text?: string;
    quotedMessageId?: string;
  },
): LineEvent {
  return messageEvent(
    p,
    {
      type: 'sticker',
      packageId: p.packageId,
      stickerId: p.stickerId,
      stickerResourceType: p.stickerResourceType ?? 'STATIC',
      ...(p.keywords ? { keywords: p.keywords } : {}),
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.quotedMessageId ? { quotedMessageId: p.quotedMessageId } : {}),
    },
    true,
  );
}

/** `messageEdited`: same message ID, a new quote token and reply token, no read token. */
export function editEvent(p: Common & { id: string; text: string; emojis?: EmojiInput[]; mentionees?: MentioneeInput[] }): LineEvent {
  return messageEvent(p, textFields(p), true, 'messageEdited');
}

export function unsendEvent(p: Common & { messageId: string }): LineEvent {
  return { ...baseEvent('unsend', p), unsend: { messageId: p.messageId } };
}

export function joinEvent(p: Omit<Common, 'userId'>): LineEvent {
  return withReplyToken(baseEvent('join', p), p);
}

export function leaveEvent(p: Omit<Common, 'userId' | 'fake'>): LineEvent {
  return baseEvent('leave', p);
}

export function memberJoinedEvent(p: Omit<Common, 'userId'> & { userIds: string[] }): LineEvent {
  const ev = withReplyToken(baseEvent('memberJoined', p), p);
  ev.joined = { members: p.userIds.map((userId) => ({ type: 'user', userId })) };
  return ev;
}

export function memberLeftEvent(p: Omit<Common, 'userId' | 'fake'> & { userIds: string[] }): LineEvent {
  return { ...baseEvent('memberLeft', p), left: { members: p.userIds.map((userId) => ({ type: 'user', userId })) } };
}

export function postbackEvent(p: Common & { data: string; params?: Record<string, string> }): LineEvent {
  const ev = withReplyToken(baseEvent('postback', p), p);
  ev.postback = { data: p.data, ...(p.params ? { params: p.params } : {}) };
  return ev;
}

/** An event type (and fields) the service doesn't know, to check it is skipped gracefully. */
export function unknownEvent(p: Omit<Common, 'fake'> & { type: string; extra?: Record<string, unknown> }): LineEvent {
  return { ...baseEvent(p.type, p), ...p.extra };
}

/**
 * Posts a signed webhook and returns the HTTP status. `redelivery` marks every event
 * `isRedelivery=true` (otherwise identical); `signature` overrides the computed one;
 * `rawBody` sends exact bytes (e.g. unusual formatting) instead of `JSON.stringify(body)`.
 */
export async function postWebhook(
  url: string,
  secret: string,
  body: WebhookBody,
  opts: { signature?: string; redelivery?: boolean; rawBody?: string } = {},
): Promise<number> {
  const events = opts.redelivery
    ? body.events.map((e) => ({ ...e, deliveryContext: { ...e.deliveryContext, isRedelivery: true } }))
    : body.events;
  const raw = opts.rawBody ?? JSON.stringify({ destination: body.destination, events });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'LineBotWebhook/2.0',
      'x-line-signature': opts.signature ?? signBody(secret, raw),
    },
    body: raw,
  });
  await res.arrayBuffer();
  return res.status;
}
