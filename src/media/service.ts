import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp, { type Metadata } from 'sharp';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { LineApiError, type LinePlatform } from '../line/adapter.js';
import type { ContentProvider, OriginMeta } from '../line/types.js';
import type { Logger } from '../logger.js';
import type { MediaRefs } from '../translate/types.js';
import { addMs, type Clock } from '../util/clock.js';
import { randomToken, uuid } from '../util/ids.js';
import { safeFetch, SafeFetchError } from './safeFetch.js';
import type { MediaMessage, MediaOutcome, MediaService, MediaStore } from './types.js';

const MIB = 1024 * 1024;
// LINE's documented limits are in "MB"; decimal megabytes keep us on the safe side of either reading.
const IMAGE_MAX_BYTES = 10_000_000;
const PREVIEW_MAX_BYTES = 1_000_000;
const AV_MAX_BYTES = 200_000_000;
const ICON_MAX_BYTES = 1_000_000;
const IMAGE_DOWNLOAD_MAX_BYTES = 50 * MIB;
const AVATAR_DOWNLOAD_MAX_BYTES = 5 * MIB;
const URL_MAX_CHARS = 2000;
const PREVIEW_MAX_DIM = 1024;
const TRANSCODE_DEADLINE_MS = 5 * 60_000;
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 30_000;
const AVATAR_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const PURGE_BATCH = 500;
// Decode limits against image bombs; truncated or corrupt input is rejected instead of half-rendered.
const SHARP_INPUT = { limitInputPixels: 50_000_000, failOn: 'error', autoOrient: true } as const;

const execFileAsync = promisify(execFile);

/** Content that can't be relayed (undecodable, over limits); the message falls back to text. */
class MediaRejected extends Error {}

type Role = 'original' | 'preview' | 'file';

interface NewObject {
  role: Role;
  key: string;
  data: Buffer;
  contentType: string;
  contentDisposition?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

interface Downloaded {
  contentType: string;
  data: Buffer;
}

interface EncodedImage {
  data: Buffer;
  contentType: 'image/jpeg' | 'image/png';
  width?: number;
  height?: number;
}

type NotReady = Exclude<MediaOutcome, { state: 'ready' }>;

export interface MediaServiceDeps {
  db: Db;
  line: LinePlatform;
  store: MediaStore;
  config: Config;
  clock: Clock;
  log: Logger;
  /** Remote fetcher for external images and avatars; defaults to the SSRF-guarded `safeFetch`. */
  fetchRemote?: typeof safeFetch;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isRelayableUrl(url: string | undefined): url is string {
  return url !== undefined && url.startsWith('https://') && url.length <= URL_MAX_CHARS;
}

function isMp4(data: Buffer): boolean {
  // ISO BMFF starts with an `ftyp` box; QuickTime (`qt  ` brand) shares the layout but LINE rejects it.
  return data.length >= 12 && data.toString('latin1', 4, 8) === 'ftyp' && data.toString('latin1', 8, 12) !== 'qt  ';
}

/** Encodes to JPEG, lowering quality and then dimensions until the result fits `maxBytes`. */
async function jpegUnder(input: Buffer, maxBytes: number, maxDim?: number): Promise<EncodedImage> {
  let limit = maxDim;
  try {
    for (let round = 0; round < 10; round++) {
      let longest = 0;
      for (const quality of [85, 70, 55]) {
        let img = sharp(input, SHARP_INPUT);
        if (limit !== undefined) img = img.resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true });
        const { data, info } = await img
          .flatten({ background: '#ffffff' })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true });
        if (data.length <= maxBytes) return { data, contentType: 'image/jpeg', width: info.width, height: info.height };
        longest = Math.max(info.width, info.height);
      }
      limit = Math.floor(longest * 0.7);
      if (limit < 16) break;
    }
  } catch (err) {
    throw new MediaRejected('image_decode', { cause: err });
  }
  throw new MediaRejected('image_too_large');
}

/** Keeps JPEG/PNG within `maxBytes` as-is; anything else is re-encoded to JPEG. */
async function fitImage(input: Buffer, maxBytes: number, maxDim?: number): Promise<EncodedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, SHARP_INPUT).metadata();
  } catch (err) {
    throw new MediaRejected('image_decode', { cause: err });
  }
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  const withinDims = maxDim === undefined || Math.max(meta.width ?? 0, meta.height ?? 0) <= maxDim;
  if (
    (meta.format === 'jpeg' || meta.format === 'png') &&
    input.length <= maxBytes &&
    pixels > 0 &&
    pixels <= SHARP_INPUT.limitInputPixels &&
    withinDims
  ) {
    return { data: input, contentType: meta.format === 'png' ? 'image/png' : 'image/jpeg', width: meta.width, height: meta.height };
  }
  return jpegUnder(input, maxBytes, maxDim);
}

/** ASCII-safe object key segment derived from an arbitrary (often non-Latin) file name. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(base)?.[1];
  const stemSource = ext === undefined ? base : base.slice(0, -(ext.length + 1));
  const stem = stemSource
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return `${stem || 'file'}${ext === undefined ? '' : `.${ext}`}`;
}

/** RFC 6266 attachment header carrying the original UTF-8 name plus an ASCII fallback. */
function attachmentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex -- sanitizing control characters from attachment header
  const clean = [...name.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, 150).join('') || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Media errors that won't go away on retry map to a failure reason; anything else is rethrown. */
function permanentFailure(err: unknown): string | null {
  if (err instanceof MediaRejected) return err.message;
  if (err instanceof LineApiError) {
    if (err.status === 404 || err.status === 410) return 'gone';
    if (err.status === 413) return 'too_large';
    return err.isRetryable ? null : `line_${err.status}`;
  }
  if (err instanceof SafeFetchError) {
    const transient = err.reason === 'network' || err.reason === 'timeout' || (err.status ?? 0) >= 500;
    return transient ? null : `remote_${err.reason}`;
  }
  return null;
}

export class DefaultMediaService implements MediaService {
  private readonly db: Db;
  private readonly line: LinePlatform;
  private readonly store: MediaStore;
  private readonly config: Config;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly fetchRemote: typeof safeFetch;
  private defaultIcon: Promise<string> | undefined;

  constructor(deps: MediaServiceDeps) {
    this.db = deps.db;
    this.line = deps.line;
    this.store = deps.store;
    this.config = deps.config;
    this.clock = deps.clock;
    this.log = deps.log;
    this.fetchRemote = deps.fetchRemote ?? safeFetch;
  }

  publicUrl(objectKey: string): string {
    const url = `${this.config.MEDIA_PUBLIC_BASE_URL}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
    if (url.length > URL_MAX_CHARS) throw new Error(`media URL exceeds ${URL_MAX_CHARS} characters; shorten MEDIA_PUBLIC_BASE_URL`);
    return url;
  }

  async fetchForMessage(msg: MediaMessage): Promise<MediaOutcome> {
    const existing = await this.db.query('select 1 from media_objects where origin_message_id = $1 limit 1', [msg.messageId]);
    if (existing.rows.length > 0) return { state: 'ready' };
    try {
      switch (msg.type) {
        case 'image':
          return await this.fetchImage(msg);
        case 'video':
          return await this.fetchVideo(msg);
        case 'audio':
          return await this.fetchAudio(msg);
        case 'file':
          return await this.fetchFile(msg);
        default:
          return { state: 'ready' };
      }
    } catch (err) {
      const reason = permanentFailure(err);
      if (reason === null) throw err;
      this.log.info({ messageId: msg.messageId, type: msg.type, reason, err }, 'media unavailable');
      return { state: 'failed', reason };
    }
  }

  /** Downloads LINE content, polling transcoding while the content endpoint answers 202. */
  private async downloadLine(msg: MediaMessage, maxBytes: number): Promise<Downloaded | NotReady> {
    let content = await this.line.getContent(msg.messageId, maxBytes);
    if (content.status === 'preparing') {
      const status = await this.line.getTranscodingStatus(msg.messageId);
      if (status === 'failed') return { state: 'failed', reason: 'transcoding_failed' };
      if (status === 'succeeded') content = await this.line.getContent(msg.messageId, maxBytes);
    }
    if (content.status === 'ready') return { contentType: content.contentType, data: content.data };
    const elapsed = this.clock.now().getTime() - msg.firstAttemptAt.getTime();
    if (elapsed >= TRANSCODE_DEADLINE_MS) return { state: 'failed', reason: 'transcoding_timeout' };
    // Waiting about as long as has already elapsed doubles the interval each round (2 s → 30 s).
    const retryInMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, elapsed), TRANSCODE_DEADLINE_MS - elapsed);
    return { state: 'pending', retryInMs };
  }

  /** LINE's own preview, if it can be used (after re-encoding when needed). */
  private async linePreview(messageId: string): Promise<EncodedImage | null> {
    try {
      const preview = await this.line.getContentPreview(messageId);
      return preview ? await fitImage(preview.data, PREVIEW_MAX_BYTES, PREVIEW_MAX_DIM) : null;
    } catch (err) {
      this.log.debug({ messageId, err }, 'LINE preview unusable; generating one');
      return null;
    }
  }

  private newKey(name: string): string {
    return `m/${randomToken()}/${name}`;
  }

  private async fetchImage(msg: MediaMessage): Promise<MediaOutcome> {
    const provider = msg.meta.contentProvider;
    if (provider?.type === 'external') return this.fetchExternalImage(msg, provider);
    const got = await this.downloadLine(msg, IMAGE_DOWNLOAD_MAX_BYTES);
    if ('state' in got) return got;
    const original = await fitImage(got.data, IMAGE_MAX_BYTES);
    const preview =
      (await this.linePreview(msg.messageId)) ?? (await jpegUnder(got.data, PREVIEW_MAX_BYTES, PREVIEW_MAX_DIM));
    return this.commit(msg, [this.imageObject('original', original), this.imageObject('preview', preview)]);
  }

  private async fetchExternalImage(msg: MediaMessage, provider: ContentProvider): Promise<MediaOutcome> {
    // Pass-through avoids fetching attacker-chosen URLs at all; refs() hands these URLs out directly.
    if (isRelayableUrl(provider.originalContentUrl) && isRelayableUrl(provider.previewImageUrl)) return { state: 'ready' };
    if (!provider.originalContentUrl) return { state: 'failed', reason: 'no_url' };
    const got = await this.fetchRemote(provider.originalContentUrl, {
      maxBytes: IMAGE_DOWNLOAD_MAX_BYTES,
      timeoutMs: REMOTE_TIMEOUT_MS,
    });
    const original = await fitImage(got.data, IMAGE_MAX_BYTES);
    const preview = await jpegUnder(got.data, PREVIEW_MAX_BYTES, PREVIEW_MAX_DIM);
    return this.commit(msg, [this.imageObject('original', original), this.imageObject('preview', preview)]);
  }

  private imageObject(role: 'original' | 'preview', img: EncodedImage): NewObject {
    const ext = img.contentType === 'image/png' ? 'png' : 'jpg';
    return { role, key: this.newKey(`${role}.${ext}`), ...img };
  }

  private async fetchVideo(msg: MediaMessage): Promise<MediaOutcome> {
    const got = await this.downloadLine(msg, AV_MAX_BYTES);
    if ('state' in got) return got;
    const video = isMp4(got.data)
      ? got.data
      : await this.runFfmpeg(msg.messageId, got.data, 'out.mp4', [
          (i, o) => ['-i', i, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', o],
          (i, o) => [
            '-i', i, '-map', '0:v:0', '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', o,
          ],
        ]);
    if (!video || video.length > AV_MAX_BYTES) return this.commitLinkOnly(msg, 'video', got);
    let preview = await this.linePreview(msg.messageId);
    if (!preview) {
      const frame = await this.runFfmpeg(msg.messageId, video, 'frame.jpg', [
        (i, o) => ['-ss', '1', '-i', i, '-frames:v', '1', '-q:v', '3', '-f', 'image2', o],
        // Clips shorter than a second have no frame at 1 s.
        (i, o) => ['-i', i, '-frames:v', '1', '-q:v', '3', '-f', 'image2', o],
      ]);
      preview = frame ? await fitImage(frame, PREVIEW_MAX_BYTES, PREVIEW_MAX_DIM).catch(() => null) : null;
    }
    if (!preview) return this.commitLinkOnly(msg, 'video', got);
    const durationMs = msg.meta.durationMs;
    return this.commit(msg, [
      { role: 'original', key: this.newKey('original.mp4'), data: video, contentType: 'video/mp4', durationMs },
      this.imageObject('preview', preview),
    ]);
  }

  private async fetchAudio(msg: MediaMessage): Promise<MediaOutcome> {
    const got = await this.downloadLine(msg, AV_MAX_BYTES);
    if ('state' in got) return got;
    const d = got.data;
    const format = isMp4(d)
      ? { ext: 'm4a', contentType: 'audio/mp4' }
      : d.toString('latin1', 0, 3) === 'ID3' || (d[0] === 0xff && ((d[1] ?? 0) & 0xe0) === 0xe0)
        ? { ext: 'mp3', contentType: 'audio/mpeg' }
        : null;
    if (!format) return this.commitLinkOnly(msg, 'audio', got);
    return this.commit(msg, [
      {
        role: 'original',
        key: this.newKey(`original.${format.ext}`),
        data: d,
        contentType: format.contentType,
        durationMs: msg.meta.durationMs,
      },
    ]);
  }

  private async fetchFile(msg: MediaMessage): Promise<MediaOutcome> {
    const cap = this.config.FILE_RELAY_MAX_MB * MIB;
    // Over the cap nothing is stored; refs() reports the file as too large.
    if (msg.meta.file && msg.meta.file.size > cap) return { state: 'ready' };
    const got = await this.downloadLine(msg, cap);
    if ('state' in got) return got;
    const name = msg.meta.file?.name ?? 'file';
    return this.commit(msg, [
      {
        role: 'file',
        key: this.newKey(safeFileName(name)),
        data: got.data,
        contentType: 'application/octet-stream',
        contentDisposition: attachmentDisposition(name),
      },
    ]);
  }

  /** Hosts media LINE can't play (wrong container, no preview) as a download link. */
  private commitLinkOnly(msg: MediaMessage, kind: 'video' | 'audio', got: Downloaded): Promise<MediaOutcome> {
    const subtype = got.contentType.split(';')[0]?.split('/')[1]?.trim().toLowerCase().replace(/^x-/, '') ?? '';
    const name = `${kind}.${/^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'bin'}`;
    return this.commit(msg, [
      {
        role: 'file',
        key: this.newKey(name),
        data: got.data,
        contentType: 'application/octet-stream',
        contentDisposition: attachmentDisposition(name),
        durationMs: msg.meta.durationMs,
      },
    ]);
  }

  /**
   * Runs ffmpeg attempts in order until one produces output. Returns null when ffmpeg is missing
   * or every attempt fails; callers then fall back to a link.
   */
  private async runFfmpeg(
    messageId: string,
    input: Buffer,
    outName: string,
    attempts: ((inPath: string, outPath: string) => string[])[],
  ): Promise<Buffer | null> {
    const dir = await mkdtemp(join(tmpdir(), 'lgb-ffmpeg-'));
    try {
      const inPath = join(dir, 'input');
      const outPath = join(dir, outName);
      await writeFile(inPath, input);
      for (const args of attempts) {
        try {
          await execFileAsync(this.config.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args(inPath, outPath)], {
            timeout: FFMPEG_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: MIB,
            windowsHide: true,
          });
        } catch (err) {
          this.log.debug({ messageId, err }, 'ffmpeg attempt failed');
          // A missing or non-executable ffmpeg fails every attempt the same way.
          const code = err instanceof Error && 'code' in err ? err.code : undefined;
          if (code === 'ENOENT' || code === 'EACCES') return null;
          continue;
        }
        const out = await readFile(outPath).catch(() => null);
        if (out && out.length > 0) return out;
      }
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Stores objects, then records them, unless the message was unsent or purged meanwhile
   * (then the objects are removed again so nothing outlives the unsend).
   */
  private async commit(msg: MediaMessage, objects: NewObject[]): Promise<MediaOutcome> {
    const now = this.clock.now();
    const days = msg.type === 'image' ? this.config.RETENTION_MEDIA_DAYS : this.config.RETENTION_AV_DAYS;
    const expiresAt = addMs(now, days * DAY_MS);
    const keys = objects.map((o) => o.key);
    let recorded = false;
    try {
      for (const o of objects) {
        await this.store.put(
          o.key,
          o.data,
          o.contentType,
          o.contentDisposition === undefined ? undefined : { contentDisposition: o.contentDisposition },
        );
      }
      recorded = await this.db.tx(async (q) => {
        const { rows } = await q.query<{ live: boolean }>(
          'select (unsent_at is null and purged_at is null) as live from origin_messages where message_id = $1 for update',
          [msg.messageId],
        );
        if (!rows[0]?.live) return false;
        for (const o of objects) {
          await q.query(
            `insert into media_objects
               (id, origin_message_id, role, object_key, content_type, bytes, width, height, duration_ms, sha256, expires_at, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              uuid(), msg.messageId, o.role, o.key, o.contentType, o.data.length,
              o.width ?? null, o.height ?? null, o.durationMs ?? null, sha256(o.data), expiresAt, now,
            ],
          );
        }
        return true;
      });
    } finally {
      if (!recorded) await this.deleteObjects(keys);
    }
    return recorded ? { state: 'ready' } : { state: 'failed', reason: 'message_gone' };
  }

  private async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.store.delete(key).catch((err: unknown) => {
        this.log.warn({ key, err }, 'could not delete orphaned media object');
      });
    }
  }

  async refs(originMessageId: string, type: string, meta: OriginMeta, mediaState: string): Promise<MediaRefs | null> {
    if (type !== 'image' && type !== 'video' && type !== 'audio' && type !== 'file') return null;
    if (mediaState === 'failed') return { unavailable: true };
    if (type === 'file' && meta.file && meta.file.size > this.config.FILE_RELAY_MAX_MB * MIB) return { tooLarge: true };
    const { rows } = await this.db.query<{ role: string; object_key: string }>(
      'select role, object_key from media_objects where origin_message_id = $1',
      [originMessageId],
    );
    const refs: MediaRefs = {};
    for (const row of rows) {
      const url = this.publicUrl(row.object_key);
      if (row.role === 'original') refs.originalUrl = url;
      else if (row.role === 'preview') refs.previewUrl = url;
      else if (row.role === 'file') refs.linkUrl = url;
    }
    const provider = meta.contentProvider;
    if (
      rows.length === 0 &&
      type === 'image' &&
      provider?.type === 'external' &&
      isRelayableUrl(provider.originalContentUrl) &&
      isRelayableUrl(provider.previewImageUrl)
    ) {
      refs.originalUrl = provider.originalContentUrl;
      refs.previewUrl = provider.previewImageUrl;
    }
    if ((type === 'video' || type === 'audio') && meta.durationMs !== undefined) refs.durationMs = meta.durationMs;
    const playable =
      type === 'audio' ? refs.originalUrl !== undefined : refs.originalUrl !== undefined && refs.previewUrl !== undefined;
    if (!playable && refs.linkUrl === undefined) return { unavailable: true };
    return refs;
  }

  /** Deletes objects then rows; returns the ids whose object could not be deleted (row kept for retry). */
  private async purgeRows(rows: { id: string; object_key: string }[]): Promise<string[]> {
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await this.store.delete(row.object_key);
      } catch (err) {
        this.log.warn({ key: row.object_key, err }, 'media object deletion failed');
        failed.push(row.id);
        continue;
      }
      await this.db.query('delete from media_objects where id = $1', [row.id]);
    }
    return failed;
  }

  async purgeMessage(originMessageId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string; object_key: string }>(
      'select id, object_key from media_objects where origin_message_id = $1',
      [originMessageId],
    );
    const failed = await this.purgeRows(rows);
    if (failed.length > 0) throw new Error(`could not delete ${failed.length} media object(s) of ${originMessageId}`);
  }

  async purgeExpired(now: Date): Promise<number> {
    let deleted = 0;
    const skipped: string[] = [];
    for (;;) {
      const { rows } = await this.db.query<{ id: string; object_key: string }>(
        `select id, object_key from media_objects
          where expires_at <= $1 and not (id = any($2::uuid[]))
          order by expires_at limit ${PURGE_BATCH}`,
        [now, skipped],
      );
      const failed = await this.purgeRows(rows);
      deleted += rows.length - failed.length;
      skipped.push(...failed);
      if (rows.length < PURGE_BATCH) return deleted;
    }
  }

  async ensureAvatar(pictureUrl: string): Promise<{ objectKey: string; hash: string } | null> {
    try {
      const got = await this.fetchRemote(pictureUrl, { maxBytes: AVATAR_DOWNLOAD_MAX_BYTES, timeoutMs: AVATAR_TIMEOUT_MS });
      let png: Buffer | undefined;
      let size = 0;
      for (size of [256, 128]) {
        const out = await sharp(got.data, SHARP_INPUT)
          .resize(size, size, { fit: 'cover', position: 'centre' })
          .png({ compressionLevel: 9 })
          .toBuffer();
        if (out.length <= ICON_MAX_BYTES) {
          png = out;
          break;
        }
      }
      if (!png) throw new MediaRejected('avatar_too_large');
      const hash = sha256(png);
      const { rows } = await this.db.query<{ object_key: string }>(
        "select object_key from media_objects where role = 'avatar' and sha256 = $1 limit 1",
        [hash],
      );
      if (rows[0]) return { objectKey: rows[0].object_key, hash };
      const objectKey = `i/${randomToken()}/${hash}.png`;
      await this.store.put(objectKey, png, 'image/png');
      await this.db.query(
        `insert into media_objects (id, origin_message_id, role, object_key, content_type, bytes, width, height, sha256, expires_at, created_at)
         values ($1, null, 'avatar', $2, 'image/png', $3, $4, $4, $5, null, $6)`,
        [uuid(), objectKey, png.length, size, hash, this.clock.now()],
      );
      return { objectKey, hash };
    } catch (err) {
      this.log.warn({ err }, 'avatar conversion failed');
      return null;
    }
  }

  defaultIconUrl(): Promise<string> {
    this.defaultIcon ??= this.createDefaultIcon().catch((err: unknown) => {
      this.defaultIcon = undefined;
      throw err;
    });
    return this.defaultIcon;
  }

  private async createDefaultIcon(): Promise<string> {
    const bubbles = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
        <path d="M44 56h100a22 22 0 0 1 22 22v50a22 22 0 0 1-22 22H92l-30 26v-26H44a22 22 0 0 1-22-22V78a22 22 0 0 1 22-22z" fill="#ffffff" fill-opacity="0.92"/>
        <path d="M112 108h100a22 22 0 0 1 22 22v50a22 22 0 0 1-22 22h-18v26l-30-26h-52a22 22 0 0 1-22-22v-50a22 22 0 0 1 22-22z" fill="#d7f2ec" fill-opacity="0.88"/>
      </svg>`,
    );
    const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#2a9d8f' } })
      .composite([{ input: bubbles }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    // Same bytes → same key, so concurrent processes converge on one object and one row.
    const hash = sha256(png);
    const objectKey = `i/default/${hash}.png`;
    await this.store.put(objectKey, png, 'image/png');
    await this.db.query(
      `insert into media_objects (id, origin_message_id, role, object_key, content_type, bytes, width, height, sha256, expires_at, created_at)
       values ($1, null, 'default_icon', $2, 'image/png', $3, 256, 256, $4, null, $5)
       on conflict (object_key) do nothing`,
      [uuid(), objectKey, png.length, hash, this.clock.now()],
    );
    return this.publicUrl(objectKey);
  }
}
