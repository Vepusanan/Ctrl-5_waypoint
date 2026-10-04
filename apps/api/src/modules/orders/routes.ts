import {
  apiErrorSchema,
  createOrderRequestSchema,
  idParamsSchema,
  ifMatchHeadersSchema,
  listOrdersQuerySchema,
  orderListResponseSchema,
  orderSchema,
  updateOrderRequestSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createOrderService } from './service.ts';

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createOrderService(app.db, app.audit, app.domainEvents, app.clock);

  app.get(
    '/orders',
    {
      preValidation: app.requireRole('dispatcher', 'store_manager'),
      schema: {
        tags: ['orders'],
        querystring: listOrdersQuerySchema,
        response: {
          200: orderListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.list(request.user, request.query),
  );

  app.get(
    '/orders/:id',
    {
      preValidation: app.requireRole('dispatcher', 'store_manager'),
      schema: {
        tags: ['orders'],
        params: idParamsSchema,
        response: {
          200: orderSchema,
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
    '/orders',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['orders'],
        body: createOrderRequestSchema,
        response: {
          201: orderSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const order = await service.create(request.user, request.body);
      return reply.code(201).send(order);
    },
  );

  app.patch(
    '/orders/:id',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['orders'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        body: updateOrderRequestSchema,
        response: {
          200: orderSchema,
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
      service.update(request.user, request.params.id, request.headers['if-match'], request.body),
  );

  app.post(
    '/orders/:id/cancel',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['orders'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        response: {
          200: orderSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.cancel(request.user, request.params.id, request.headers['if-match']),
  );
};
