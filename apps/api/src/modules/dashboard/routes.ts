import {
  apiErrorSchema,
  auditTimelineQuerySchema,
  auditTimelineSchema,
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardDateQuerySchema,
  dashboardExceptionsSchema,
  dashboardSummarySchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ApiError } from '../../plugins/errors.ts';
import { createDashboardService } from './service.ts';
import {
  dashboardEventVisible,
  streamEventFrame,
  streamPreamble,
  toDashboardStreamMessage,
} from './stream.ts';

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createDashboardService(app.db, app.clock);

  app.get(
    '/dashboard/summary',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['dashboard'],
        querystring: dashboardDateQuerySchema,
        response: {
          200: dashboardSummarySchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.summary(request.user, request.query.date),
  );

  app.get(
    '/dashboard/exceptions',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['dashboard'],
        querystring: dashboardDateQuerySchema,
        response: {
          200: dashboardExceptionsSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.exceptions(request.user, request.query.date),
  );

  // SYSTEM_DESIGN §11.3. One entity timeline, read from the existing audit log.
  app.get(
    '/audit',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['dashboard'],
        querystring: auditTimelineQuerySchema,
        response: {
          200: auditTimelineSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) =>
      service.timeline(request.user, request.query.entityType, request.query.entityId),
  );

  // SYSTEM_DESIGN §11.2. Summary and exceptions stay valid when this stream is down.
  app.get(
    '/dashboard/stream',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: { tags: ['dashboard'] },
    },
    async (request, reply) => {
      const user = request.user;
      if (user === null || user.role !== 'dispatcher') {
        throw new ApiError('UNAUTHENTICATED', 'Sign in required');
      }
      const outletIds = await service.outletIds(user);
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let ping: ReturnType<typeof setInterval> | undefined;
      const write = (chunk: string): boolean => {
        if (closed || reply.raw.writableEnded || reply.raw.destroyed) return false;
        try {
          return reply.raw.write(chunk);
        } catch {
          return false;
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping !== undefined) clearInterval(ping);
        unsubscribe();
      };
      ping = setInterval(() => {
        if (!write(': ping\n\n')) cleanup();
      }, DASHBOARD_POLL_INTERVAL_MS);
      ping.unref();
      unsubscribe = app.domainEvents.subscribe((event) => {
        if (closed || !dashboardEventVisible(user.depotId, outletIds, event)) return;
        if (!write(streamEventFrame(toDashboardStreamMessage(event)))) cleanup();
      });
      request.raw.on('close', cleanup);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (!write(streamPreamble())) cleanup();
    },
  );
};
