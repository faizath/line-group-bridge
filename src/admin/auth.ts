import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pre-handler hook verifying the bearer token against ADMIN_API_TOKENS (NFR-SEC-4). */
export function adminAuth(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'unauthorized', message: 'Bearer token required' });
      return;
    }
    const token = header.slice(7).trim();
    if (!token) {
      reply.code(401).send({ error: 'unauthorized', message: 'Empty token' });
      return;
    }

    const presentedHash = Buffer.from(hashToken(token), 'hex');
    const allowed = ctx.config.ADMIN_API_TOKENS.some((allowedHex) => {
      try {
        const expected = Buffer.from(allowedHex.trim(), 'hex');
        return expected.length === presentedHash.length && timingSafeEqual(expected, presentedHash);
      } catch {
        return false;
      }
    });

    if (!allowed) {
      reply.code(401).send({ error: 'unauthorized', message: 'Invalid token' });
    }
  };
}

/** Utility for operators to hash an admin token before putting it into the config. */
export function hashAdminToken(plain: string): string {
  return hashToken(plain);
}
