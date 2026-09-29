import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isValidObjectKey } from './store.js';
import type { MediaStore } from './types.js';

// Only types the bridge itself produces; anything else in the bucket is never served (no stored-XSS surface).
const SERVABLE_TYPES: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'video/mp4': true,
  'audio/mp4': true,
  'audio/x-m4a': true,
  'audio/mpeg': true,
  'application/octet-stream': true,
};

/** Single `bytes=` range (video players need it); null = serve the whole body, 'unsatisfiable' = 416. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Public media origin: `GET /m/*` (message media) and `GET /i/*` (icons). */
export async function mediaRoutes(app: FastifyInstance, opts: { store: MediaStore }): Promise<void> {
  const serve = (prefix: 'm' | 'i') => async (req: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
    const key = `${prefix}/${req.params['*']}`;
    const obj = isValidObjectKey(key) ? await opts.store.get(key) : null;
    const contentType = obj?.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!obj || !Object.hasOwn(SERVABLE_TYPES, contentType)) {
      return reply.code(404).header('X-Content-Type-Options', 'nosniff').send();
    }
    reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Accept-Ranges', 'bytes');
    const disposition = obj.contentDisposition ?? (contentType === 'application/octet-stream' ? 'attachment' : undefined);
    if (disposition !== undefined) reply.header('Content-Disposition', disposition);
    const size = obj.data.length;
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    if (range === null) return reply.send(obj.data);
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .send(obj.data.subarray(range.start, range.end + 1));
  };
  app.get<{ Params: { '*': string } }>('/m/*', serve('m'));
  app.get<{ Params: { '*': string } }>('/i/*', serve('i'));
}
