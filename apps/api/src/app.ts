import type { Database } from '@waypoint/database';
import Fastify, { type FastifyServerOptions, LogController } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { adminRoutes } from './modules/admin/routes.ts';
import type { DemoSeedConfig } from './modules/admin/service.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { dashboardRoutes } from './modules/dashboard/routes.ts';
import { deliveryRoutes } from './modules/deliveries/routes.ts';
import { healthRoutes } from './modules/health/routes.ts';
import { insightRoutes } from './modules/insights/routes.ts';
import { loadingRoutes } from './modules/loading/routes.ts';
import { notificationRoutes } from './modules/notifications/routes.ts';
import { orderRoutes } from './modules/orders/routes.ts';
import { planningRoutes } from './modules/planning/routes.ts';
import { savedViewRoutes } from './modules/planning/views.ts';
import { receiptRoutes } from './modules/receipts/routes.ts';
import { referenceRoutes } from './modules/reference/routes.ts';
import { storeRoutes } from './modules/store/routes.ts';
import { syncRoutes } from './modules/sync/routes.ts';
import { tripRoutes } from './modules/trips/routes.ts';
import { auditPlugin } from './plugins/audit.ts';
import { authPlugin } from './plugins/auth.ts';
import { clockPlugin } from './plugins/clock.ts';
import { dbPlugin } from './plugins/db.ts';
import { domainEventsPlugin } from './plugins/domain-events.ts';
import { errorPlugin } from './plugins/errors.ts';
import { rbacPlugin } from './plugins/rbac.ts';
import { swaggerPlugin } from './plugins/swagger.ts';

export interface AppOptions {
  db: Database;
  logger: NonNullable<FastifyServerOptions['logger']>;
  sessionSecret: string;
  secureCookies: boolean;
  // Admin routes are registered only when this is true. Production leaves it false.
  demoMode?: boolean;
  seed?: DemoSeedConfig;
  /** Sign-in attempts per address per minute. Defaults to 10 (SYSTEM_DESIGN §9.1). */
  loginLimit?: number;
}

export async function buildApp({
  db,
  logger,
  sessionSecret,
  secureCookies,
  demoMode = false,
  seed,
  loginLimit,
}: AppOptions) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    // Trust Caddy on the Docker network, or a proxy on loopback. A public peer
    // cannot supply X-Forwarded-* and receive a fresh login rate-limit key.
    trustProxy: 'loopback, uniquelocal',
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorPlugin);
  await app.register(dbPlugin, { db });
  await app.register(auditPlugin);
  await app.register(clockPlugin, { demoMode });
  await app.register(domainEventsPlugin);
  await app.register(authPlugin, { sessionSecret, secureCookies });
  await app.register(rbacPlugin);

  // SYSTEM_DESIGN §13.4: one line per request with the signed-in user when there is one.
  // Registered before routes so encapsulated plugins, including Swagger, inherit it.
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        reqId: request.id,
        userId: request.user?.id ?? null,
        role: request.user?.role ?? null,
        route: request.routeOptions.url ?? request.url,
        statusCode: reply.statusCode,
        latency: reply.elapsedTime,
      },
      'request',
    );
    done();
  });

  await app.register(swaggerPlugin);
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, {
    prefix: '/api/v1',
    ...(loginLimit !== undefined ? { loginLimit } : {}),
  });
  await app.register(referenceRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  await app.register(planningRoutes, { prefix: '/api/v1' });
  await app.register(savedViewRoutes, { prefix: '/api/v1' });
  await app.register(tripRoutes, { prefix: '/api/v1' });
  await app.register(loadingRoutes, { prefix: '/api/v1' });
  await app.register(deliveryRoutes, { prefix: '/api/v1' });
  await app.register(receiptRoutes, { prefix: '/api/v1' });
  await app.register(storeRoutes, { prefix: '/api/v1' });
  await app.register(syncRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  await app.register(insightRoutes, { prefix: '/api/v1' });
  if (demoMode) {
    if (seed === undefined) {
      throw new Error('DEMO_MODE requires seed configuration');
    }
    await app.register(adminRoutes(seed), { prefix: '/api/v1' });
  }

  return app;
}
