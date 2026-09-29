import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaRoutes } from '../../src/media/routes.js';
import { FsMediaStore } from '../../src/media/store.js';

describe('mediaRoutes', () => {
  let tmpDir: string;
  let store: FsMediaStore;
  let app: FastifyInstance;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lgb-media-routes-'));
    store = new FsMediaStore(tmpDir);
    app = Fastify();
    await app.register(mediaRoutes, { store });
  });

  afterAll(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('serves images under /m/ with correct headers', async () => {
    const key = 'm/rand123/original.jpg';
    await store.put(key, Buffer.from('fake-jpeg-data'), 'image/jpeg');

    const res = await app.inject({ method: 'GET', url: `/${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(Buffer.from('fake-jpeg-data'));
  });

  it('serves avatars under /i/ with image/png content type', async () => {
    const key = 'i/rand456/hash.png';
    await store.put(key, Buffer.from('fake-png-data'), 'image/png');

    const res = await app.inject({ method: 'GET', url: `/${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload).toEqual(Buffer.from('fake-png-data'));
  });

  it('serves attachments with Content-Disposition header', async () => {
    const key = 'm/rand789/document.pdf';
    await store.put(key, Buffer.from('fake-pdf'), 'application/octet-stream', {
      contentDisposition: 'attachment; filename="document.pdf"',
    });

    const res = await app.inject({ method: 'GET', url: `/${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="document.pdf"');
  });

  it('returns 404 for unknown keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/m/unknown/file.jpg' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects path traversal attempts', async () => {
    const res = await app.inject({ method: 'GET', url: '/m/../secret' });
    expect([400, 404]).toContain(res.statusCode);
  });
});
