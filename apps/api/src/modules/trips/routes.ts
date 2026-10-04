import {
  apiErrorSchema,
  idParamsSchema,
  ifMatchHeadersSchema,
  listTripsQuerySchema,
  resequenceTripRequestSchema,
  tripDetailSchema,
  tripListResponseSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createTripService } from './service.ts';

const readRoles = ['dispatcher', 'loader', 'driver'] as const;

export const tripRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createTripService(app.db, app.audit, app.domainEvents, app.clock);

  app.get(
    '/trips',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['trips'],
        querystring: listTripsQuerySchema,
        response: {
          200: tripListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.list(request.user, request.query),
  );

  app.get(
    '/trips/:id',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['trips'],
        params: idParamsSchema,
        response: {
          200: tripDetailSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.get(request.user, request.params.id),
  );

  app.post(
    '/trips/:id/resequence',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['trips'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        body: resequenceTripRequestSchema,
        response: {
          200: tripDetailSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) =>
      service.resequence(
        request.user,
        request.params.id,
        request.headers['if-match'],
        request.body,
      ),
  );

  app.post(
    '/trips/:id/depart',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['trips'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        response: {
          200: tripDetailSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.depart(request.user, request.params.id, request.headers['if-match']),
  );
};
