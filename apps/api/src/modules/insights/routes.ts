import {
  apiErrorSchema,
  demandInsightSchema,
  demandQuerySchema,
  outletHistoryListSchema,
  outletIdSchema,
  outletProfileFactsSchema,
  outletProfileQuerySchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createInsightService } from './service.ts';

const errors = { 400: apiErrorSchema, 401: apiErrorSchema, 403: apiErrorSchema };

export const insightRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createInsightService(app.db);

  app.get(
    '/analytics/demand',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['insights'],
        querystring: demandQuerySchema,
        response: { 200: demandInsightSchema, ...errors },
      },
    },
    async (request) => service.demand(request.user, request.query.date),
  );

  app.get(
    '/outlets/history',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: { tags: ['insights'], response: { 200: outletHistoryListSchema, ...errors } },
    },
    async (request) => service.outletHistory(request.user),
  );

  app.get(
    '/outlets/:id/profile',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['insights'],
        params: z.object({ id: outletIdSchema }),
        querystring: outletProfileQuerySchema,
        response: { 200: outletProfileFactsSchema, ...errors, 404: apiErrorSchema },
      },
    },
    async (request) => service.outletProfile(request.user, request.params.id, request.query.date),
  );
};
