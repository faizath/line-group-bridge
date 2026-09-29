import type { Translate } from '../i18n/index.js';
import type { OriginMeta, OutboundMessage, Sender } from '../line/types.js';

export type OriginTagStyle = 'none' | 'name_suffix' | 'text_prefix';

/** Origin message as stored (origin_messages row subset). */
export interface OriginForTranslate {
  messageId: string;
  type: string; // text | image | video | audio | file | location | sticker (others → [message] fallback)
  text: string | null;
  meta: OriginMeta;
}

/** Quote resolved for one target group (FR-EVT-1/2). */
export interface QuoteInfo {
  /** The target group's copy quote token (or origin quote token when target is the origin group). */
  quoteToken: string | null;
  authorName: string;
  /** Stored origin text / "[photo]" / "[message]"; the translator truncates to 50 units. */
  snippet: string;
}

/** Hosted media for an origin message (FR-MSG-5..9). */
export interface MediaRefs {
  originalUrl?: string;
  previewUrl?: string;
  /** Hosted file download link (file messages, or video/audio that violate LINE limits). */
  linkUrl?: string;
  durationMs?: number;
  /** Download failed (404/410/transcoding failed) → text fallback. */
  unavailable?: boolean;
  /** File larger than FILE_RELAY_MAX_MB → name/size only. */
  tooLarge?: boolean;
}

export interface TranslateContext {
  bridge: { name: string; originTagStyle: OriginTagStyle; iconUrl: string };
  originGroup: { shortTag: string };
  author: { displayName: string | null; iconUrl: string | null };
  quote: QuoteInfo | null;
  media: MediaRefs | null;
  isStickerSendable(packageId: string, stickerId: string): boolean;
  /** 0 = normal; 1..4 = fallback ladder steps of [09] §9, cumulative. */
  fallbackStep: number;
  forbiddenWords: string[];
  /** userIds known to be members of the target group; mentions of them become real textV2 mentions (FR-MSG-3 C). */
  targetMemberIds: ReadonlySet<string>;
  t: Translate;
}

export type EditContext = TranslateContext;

/** One job's contribution to a request, input to packing. */
export interface PackItem {
  jobId: string;
  originMessageId: string | null;
  /** Author label used in digest headers, e.g. "Ken·B". */
  authorLabel: string;
  objects: OutboundMessage[];
}

export interface PackedPart {
  jobIds: string[];
  originMessageIds: string[];
  partIndex: number;
}

export interface PackResult {
  messages: OutboundMessage[];
  /** Aligned with `messages`: which jobs/origin messages each object represents. */
  parts: PackedPart[];
  /** Jobs whose content is in `messages`. */
  includedJobIds: string[];
  /** Jobs represented only by the "…and N more messages" line (economy digests). */
  summarizedJobIds: string[];
}

export interface PackOptions {
  /** `preserve` (immediate): whole items in order up to 5 objects, no merging; the rest stay queued.
   *  `merge` (batched): like preserve, but merges consecutive texts into digest objects when more
   *  than 5 objects are ready; items that still don't fit stay queued.
   *  `digest` (economy flushes): merge texts, collapse media overflow into "📷 N more…" lines and
   *  summarize what still doesn't fit as "…and N more messages", so everything is consumed. */
  mode: 'preserve' | 'merge' | 'digest';
  maxObjects?: number;
  /** Sender used for merged multi-author digest objects. */
  digestSender: Sender;
  t: Translate;
}
