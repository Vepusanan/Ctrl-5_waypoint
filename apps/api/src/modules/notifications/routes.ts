import {
  apiErrorSchema,
  idParamsSchema,
  notificationFeedItemSchema,
  notificationListResponseSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { everyRole } from '../../plugins/rbac.ts';
import { createNotificationService } from './service.ts';

export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createNotificationService(app.db, app.clock);

  app.get(
    '/notifications',
    {
      preValidation: app.requireRole(...everyRole()),
      schema: {
        tags: ['notifications'],
        response: {
          200: notificationListResponseSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.list(request.user),
  );

  app.post(
    '/notifications/:id/read',
    {
      preValidation: app.requireRole(...everyRole()),
      schema: {
        tags: ['notifications'],
        params: idParamsSchema,
        response: {
          200: notificationFeedItemSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.markRead(request.user, request.params.id),
  );

  app.post(
    '/notifications/:id/acknowledge',
    {
      preValidation: app.requireRole(...everyRole()),
      schema: {
        tags: ['notifications'],
        params: idParamsSchema,
        response: {
          200: notificationFeedItemSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.acknowledge(request.user, request.params.id),
  );
};
