import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app/context.js';
import { migrationsCurrent } from '../db/migrate.js';

let lastTokenCheck = 0;
let tokenOk = false;
const TOKEN_CHECK_INTERVAL_MS = 60_000;

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/healthz', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  app.get('/readyz', async (_req, reply) => {
    let dbOk = false;
    let migrationsOk = false;
    try {
      await ctx.db.query('select 1');
      dbOk = true;
      migrationsOk = await migrationsCurrent(ctx.db);
    } catch {
      // DB unreachable
    }

    const now = Date.now();
    if (now - lastTokenCheck > TOKEN_CHECK_INTERVAL_MS) {
      try {
        const info = await ctx.line.getBotInfo();
        ctx.bot.userId = info.userId;
        tokenOk = true;
        lastTokenCheck = now;
      } catch {
        tokenOk = false;
      }
    }

    const ready = dbOk && migrationsOk && tokenOk;
    const code = ready ? 200 : 503;
    return reply.code(code).send({
      status: ready ? 'ready' : 'unavailable',
      checks: {
        database: dbOk,
        migrations: migrationsOk,
        lineToken: tokenOk,
      },
    });
  });
}
