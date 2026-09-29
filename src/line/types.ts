// Tolerant inbound webhook shapes. LINE adds event types, fields and enum values
// without notice (FR-ING-8, NFR-REL-8), so every union stays open-ended and
// consumers must treat unknown values as "log and skip".

import type { messagingApi } from '@line/bot-sdk';

export type OutboundMessage = messagingApi.Message;
export type Sender = messagingApi.Sender;

export interface WebhookBody {
  destination: string;
  events: LineEvent[];
}

export interface LineSource {
  type: 'group' | 'user' | 'room' | (string & {});
  groupId?: string;
  roomId?: string;
  userId?: string;
}

export interface Emoji {
  index: number;
  length: number;
  productId: string;
  emojiId: string;
}

export interface Mentionee {
  index: number;
  length: number;
  type: 'user' | 'all' | (string & {});
  userId?: string;
  isSelf?: boolean;
}

export interface ContentProvider {
  type: 'line' | 'external' | (string & {});
  originalContentUrl?: string;
  previewImageUrl?: string;
}

export interface ImageSet {
  id: string;
  index?: number;
  total?: number;
}

export interface InboundMessage {
  id: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'sticker' | (string & {});
  quoteToken?: string;
  quotedMessageId?: string;
  // text
  text?: string;
  emojis?: Emoji[];
  mention?: { mentionees: Mentionee[] };
  // image / video / audio
  contentProvider?: ContentProvider;
  imageSet?: ImageSet;
  duration?: number;
  // file
  fileName?: string;
  fileSize?: number;
  // location
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  // sticker
  packageId?: string;
  stickerId?: string;
  stickerResourceType?: string;
  keywords?: string[];
  [extra: string]: unknown;
}

export interface LineEvent {
  type: string;
  mode?: 'active' | 'standby' | (string & {});
  timestamp: number;
  source?: LineSource;
  webhookEventId: string;
  deliveryContext?: { isRedelivery?: boolean };
  replyToken?: string;
  message?: InboundMessage;
  unsend?: { messageId: string };
  joined?: { members: LineSource[] };
  left?: { members: LineSource[] };
  [extra: string]: unknown;
}

/** Relay-relevant metadata kept in `origin_messages.meta` (purged with the text). */
export interface OriginMeta {
  emojis?: Emoji[];
  mentionees?: Mentionee[];
  sticker?: {
    packageId: string;
    stickerId: string;
    resourceType?: string;
    keywords?: string[];
    text?: string;
  };
  imageSet?: ImageSet;
  contentProvider?: ContentProvider;
  durationMs?: number;
  file?: { name: string; size: number };
  location?: { title?: string; address?: string; latitude: number; longitude: number };
}
