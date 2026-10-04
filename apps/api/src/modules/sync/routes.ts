import {
  apiErrorSchema,
  idParamsSchema,
  syncEventsRequestSchema,
  syncEventsResponseSchema,
  syncTripDeltaSchema,
  versionQuerySchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createSyncService } from './service.ts';

export const syncRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createSyncService(app.db, app.audit, app.domainEvents, app.clock);

  app.post(
    '/sync/events',
    {
      preValidation: app.requireRole('driver'),
      schema: {
        tags: ['sync'],
        body: syncEventsRequestSchema,
        response: {
          200: syncEventsResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const response = await service.ingest(request.user, request.body);
      const counts = { applied: 0, duplicate: 0, conflict: 0, rejected: 0 };
      for (const result of response.results) {
        counts[result.status] += 1;
        if (result.status === 'conflict') {
          request.log.info({ clientEventId: result.clientEventId }, 'sync.conflict');
        }
      }
      request.log.info(counts, 'sync.batch');
      return reply.code(200).send(response);
    },
  );

  app.get(
    '/sync/trips/:id',
    {
      preValidation: app.requireRole('driver'),
      schema: {
        tags: ['sync'],
        params: idParamsSchema,
        querystring: versionQuerySchema,
        response: {
          200: syncTripDeltaSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request) => service.tripDelta(request.user, request.params.id, request.query.since),
  );
};
