import {
  apiErrorSchema,
  operatingClockSchema,
  seedResetRequestSchema,
  seedResetResponseSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { clearSessionCookieOptions, SESSION_COOKIE } from '../auth/cookies.ts';
import { createAdminService, type DemoSeedConfig } from './service.ts';

export function adminRoutes(seed: DemoSeedConfig): FastifyPluginAsyncZod {
  const plugin: FastifyPluginAsyncZod = async (app) => {
    const service = createAdminService(app.db, app.audit, app.clock, app.log, seed);

    // Drivers read the clock to stamp stop events on the demo timeline; only the dispatcher
    // may move it or reset the seed.
    app.get(
      '/admin/clock',
      {
        preHandler: app.requireRole('dispatcher', 'driver'),
        schema: {
          tags: ['admin'],
          response: {
            200: operatingClockSchema,
            401: apiErrorSchema,
            403: apiErrorSchema,
          },
        },
      },
      async () => service.readClock(),
    );

    app.put(
      '/admin/clock',
      {
        preHandler: app.requireRole('dispatcher'),
        schema: {
          tags: ['admin'],
          body: operatingClockSchema,
          response: {
            200: operatingClockSchema,
            400: apiErrorSchema,
            401: apiErrorSchema,
            403: apiErrorSchema,
          },
        },
      },
      async (request) => {
        const clock = await service.setClock(request.user, request.body);
        // The pinned time may be past the generated calendar.
        await app.ensureCalendar();
        return clock;
      },
    );

    app.post(
      '/admin/reset',
      {
        preHandler: app.requireRole('dispatcher'),
        schema: {
          tags: ['admin'],
          body: seedResetRequestSchema,
          response: {
            200: seedResetResponseSchema,
            400: apiErrorSchema,
            401: apiErrorSchema,
            403: apiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await service.reset(request.user, request.body);
        reply.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(app.secureCookies));
        return result;
      },
    );
  };

  return plugin;
}
