import type { OriginMeta } from '../line/types.js';
import type { MediaRefs } from '../translate/types.js';

export interface StoredObject {
  data: Buffer;
  contentType: string;
  contentDisposition?: string;
}

/** Object storage backend (S3-compatible or local filesystem). Keys are URL paths below MEDIA_PUBLIC_BASE_URL. */
export interface MediaStore {
  put(key: string, data: Buffer, contentType: string, opts?: { contentDisposition?: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Readiness probe. */
  ping(): Promise<void>;
}

export type MediaOutcome =
  | { state: 'ready' }
  /** LINE is still transcoding; call again after `retryInMs`. */
  | { state: 'pending'; retryInMs: number }
  | { state: 'failed'; reason: string };

export interface MediaMessage {
  messageId: string;
  type: string;
  meta: OriginMeta;
  /** First download attempt time; video/audio transcoding polling gives up 5 min after it. */
  firstAttemptAt: Date;
}

export interface MediaService {
  /** Downloads, converts and stores the content of an image/video/audio/file message (FR-MSG-5..9, -11). */
  fetchForMessage(msg: MediaMessage): Promise<MediaOutcome>;
  /** Hosted URLs for the message, or null if the message has no media. */
  refs(originMessageId: string, type: string, meta: OriginMeta, mediaState: string): Promise<MediaRefs | null>;
  /** Deletes stored objects and rows for the message (unsend, retention). */
  purgeMessage(originMessageId: string): Promise<void>;
  /** Square PNG ≤ 1 MB derived from the LINE avatar, deduplicated by content hash (FR-ATT-4). */
  ensureAvatar(pictureUrl: string): Promise<{ objectKey: string; hash: string } | null>;
  /** Public HTTPS URL of the bundled default bridge icon. */
  defaultIconUrl(): Promise<string>;
  publicUrl(objectKey: string): string;
  /** Deletes media objects whose expires_at has passed. Returns the count deleted. */
  purgeExpired(now: Date): Promise<number>;
}
