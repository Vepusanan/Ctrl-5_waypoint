import {
  apiErrorSchema,
  idParamsSchema,
  storeOrderDetailSchema,
  storeWorkspaceSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createStoreService } from './service.ts';
export const storeRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createStoreService(app.db, app.clock, app.audit, app.domainEvents);
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
  };
  app.get(
    '/store/workspace',
    {
      preValidation: app.requireRole('store_manager'),
      schema: { tags: ['store'], response: { 200: storeWorkspaceSchema, ...errors } },
    },
    (request) => service.workspace(request.user),
  );
  app.get(
    '/store/orders/:id',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['store'],
        params: idParamsSchema,
        response: { 200: storeOrderDetailSchema, ...errors },
      },
    },
    (request) => service.detail(request.user, request.params.id),
  );
};
