import {
  apiErrorSchema,
  createLoadingIssueRequestSchema,
  idParamsSchema,
  ifMatchHeadersSchema,
  loadingIssueSchema,
  loadingStateSchema,
  setLoadingCountRequestSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createLoadingService } from './service.ts';

const readRoles = ['dispatcher', 'loader', 'driver'] as const;

export const loadingRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createLoadingService(app.db, app.audit, app.domainEvents, app.clock);

  app.get(
    '/trips/:id/loading',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        response: {
          200: loadingStateSchema,
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
    '/trips/:id/loading/start',
    {
      preValidation: app.requireRole('loader'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        response: {
          201: loadingStateSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const state = await service.start(
        request.user,
        request.params.id,
        request.headers['if-match'],
      );
      return reply.code(201).send(state);
    },
  );

  app.post(
    '/trips/:id/loading/verify',
    {
      preValidation: app.requireRole('loader'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        response: {
          200: loadingStateSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.verify(request.user, request.params.id, request.headers['if-match']),
  );

  app.put(
    '/trips/:id/loading/counts',
    {
      preValidation: app.requireRole('loader'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        body: setLoadingCountRequestSchema,
        response: {
          200: loadingStateSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.setCount(request.user, request.params.id, request.body),
  );

  app.post(
    '/trips/:id/loading/issues',
    {
      preValidation: app.requireRole('loader'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        body: createLoadingIssueRequestSchema,
        response: {
          201: loadingStateSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const state = await service.recordIssue(
        request.user,
        request.params.id,
        request.headers['if-match'],
        request.body,
      );
      return reply.code(201).send(state);
    },
  );

  app.post(
    '/loading/issues/:id/ack',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        response: {
          200: loadingIssueSchema,
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

  app.post(
    '/trips/:id/loading/ready',
    {
      preValidation: app.requireRole('loader'),
      schema: {
        tags: ['loading'],
        params: idParamsSchema,
        headers: ifMatchHeadersSchema,
        response: {
          200: loadingStateSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.ready(request.user, request.params.id, request.headers['if-match']),
  );
};
