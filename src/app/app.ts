import Fastify, { type FastifyInstance } from 'fastify';
import { adminRoutes } from '../admin/routes.js';
import type { AppContext } from './context.js';
import { healthRoutes } from './health.js';
import { webhookRoutes } from '../ingress/webhook.js';
import { mediaRoutes } from '../media/routes.js';
import type { QuotaGuard } from '../cost/quotaGuard.js';

export function buildPublicApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ forceCloseConnections: true });

  // Encapsulated plugins
  app.register(async (sub) => {
    await webhookRoutes(sub, ctx);
  });
  app.register(async (sub) => {
    await mediaRoutes(sub, { store: ctx.store });
  });

  app.register(async (sub) => {
    await healthRoutes(sub, ctx);
  });

  return app;
}

export function buildAdminApp(ctx: AppContext, quota: QuotaGuard): FastifyInstance {
  const app = Fastify({ forceCloseConnections: true });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', ctx.metrics.registry.contentType);
    return ctx.metrics.registry.metrics();
  });

  app.register(async (sub) => {
    await healthRoutes(sub, ctx);
  });

  app.register(async (sub) => {
    await adminRoutes(sub, ctx, quota);
  });

  return app;
}
