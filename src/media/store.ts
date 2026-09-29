import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { MediaStore, StoredObject } from './types.js';

const KEY_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_KEY_LENGTH = 1024;

/**
 * Object keys double as URL paths and filesystem paths, so only a conservative
 * character set is accepted, and no segment may start with a dot (this rules out
 * `.`/`..` traversal and keeps the filesystem store's `.meta` tree unreachable).
 */
export function isValidObjectKey(key: string): boolean {
  return (
    key.length <= MAX_KEY_LENGTH &&
    KEY_PATTERN.test(key) &&
    !key.includes('..') &&
    key.split('/').every((segment) => !segment.startsWith('.'))
  );
}

function assertValidKey(key: string): void {
  if (!isValidObjectKey(key)) throw new Error(`invalid media object key: ${JSON.stringify(key)}`);
}

interface Sidecar {
  contentType: string;
  contentDisposition?: string;
}

/** Local filesystem backend: data at `<root>/<key>`, metadata at `<root>/.meta/<key>.json`. */
export class FsMediaStore implements MediaStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dataPath(key: string): string {
    return join(this.root, key);
  }

  private metaPath(key: string): string {
    return join(this.root, '.meta', `${key}.json`);
  }

  async put(key: string, data: Buffer, contentType: string, opts: { contentDisposition?: string } = {}): Promise<void> {
    assertValidKey(key);
    const sidecar: Sidecar = { contentType };
    if (opts.contentDisposition !== undefined) sidecar.contentDisposition = opts.contentDisposition;
    // Data first, sidecar last: `get` requires both, so a crash mid-put never exposes a half-written object.
    await atomicWrite(this.dataPath(key), data);
    await atomicWrite(this.metaPath(key), Buffer.from(JSON.stringify(sidecar)));
  }

  async get(key: string): Promise<StoredObject | null> {
    if (!isValidObjectKey(key)) return null;
    let sidecar: Sidecar;
    let data: Buffer;
    try {
      sidecar = JSON.parse(await readFile(this.metaPath(key), 'utf8')) as Sidecar;
      data = await readFile(this.dataPath(key));
    } catch (err) {
      // EISDIR: the key names a directory (e.g. `m/<token>`), which is not an object.
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      throw err;
    }
    const obj: StoredObject = { data, contentType: sidecar.contentType };
    if (sidecar.contentDisposition !== undefined) obj.contentDisposition = sidecar.contentDisposition;
    return obj;
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    // Sidecar first so a partially deleted object is already invisible to `get`.
    await rm(this.metaPath(key), { force: true });
    await rm(this.dataPath(key), { force: true });
    // Per-message token directories would otherwise accumulate forever.
    for (const dir of [dirname(this.metaPath(key)), dirname(this.dataPath(key))]) {
      if (dir === this.root || dir === join(this.root, '.meta')) continue;
      await rmdir(dir).catch(() => undefined);
    }
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, fsConstants.W_OK);
  }
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export interface S3StoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** S3-compatible backend (AWS S3, R2, MinIO…). Content type and disposition live in object metadata. */
export class S3MediaStore implements MediaStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StoreOptions) {
    const cfg: S3ClientConfig = { region: opts.region };
    if (opts.endpoint) {
      cfg.endpoint = opts.endpoint;
      // Most self-hosted S3-compatible services don't support virtual-hosted buckets.
      cfg.forcePathStyle = true;
    }
    if (opts.accessKeyId && opts.secretAccessKey) {
      cfg.credentials = { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey };
    }
    this.client = new S3Client(cfg);
    this.bucket = opts.bucket;
  }

  async put(key: string, data: Buffer, contentType: string, opts: { contentDisposition?: string } = {}): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentDisposition: opts.contentDisposition,
        ContentLength: data.length,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    if (!isValidObjectKey(key)) return null;
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      const obj: StoredObject = {
        data: Buffer.from(await out.Body.transformToByteArray()),
        contentType: out.ContentType ?? 'application/octet-stream',
      };
      if (out.ContentDisposition) obj.contentDisposition = out.ContentDisposition;
      return obj;
    } catch (err) {
      if (err instanceof NoSuchKey || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

export function createMediaStore(config: Config): MediaStore {
  if (config.MEDIA_BACKEND === 'fs') return new FsMediaStore(config.MEDIA_FS_ROOT);
  if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required when MEDIA_BACKEND=s3');
  const opts: S3StoreOptions = { bucket: config.S3_BUCKET, region: config.S3_REGION };
  if (config.S3_ENDPOINT) opts.endpoint = config.S3_ENDPOINT;
  if (config.S3_ACCESS_KEY_ID) opts.accessKeyId = config.S3_ACCESS_KEY_ID;
  if (config.S3_SECRET_ACCESS_KEY) opts.secretAccessKey = config.S3_SECRET_ACCESS_KEY;
  return new S3MediaStore(opts);
}
