import {
  apiErrorSchema,
  createIssueRequestSchema,
  idParamsSchema,
  issueListResponseSchema,
  issueSchema,
  receiptSchema,
  resolveIssueRequestSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createReceiptService } from './service.ts';

const readRoles = ['dispatcher', 'store_manager'] as const;

// SYSTEM_DESIGN §6.2 lists receipt confirmation and issue reporting.
// §9.2 lets a dispatcher read and resolve, but the catalogue has no resolve route.
export const receiptRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createReceiptService(app.db, app.audit, app.domainEvents, app.clock);

  app.post(
    '/stops/:id/receipt',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['receipts'],
        params: idParamsSchema,
        response: {
          200: receiptSchema,
          201: receiptSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.confirm(request.user, request.params.id);
      return reply.code(result.created ? 201 : 200).send(result.receipt);
    },
  );

  app.post(
    '/issues',
    {
      preValidation: app.requireRole('store_manager'),
      schema: {
        tags: ['receipts'],
        body: createIssueRequestSchema,
        response: {
          201: issueSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const issue = await service.createIssue(request.user, request.body);
      return reply.code(201).send(issue);
    },
  );

  app.get(
    '/issues',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['receipts'],
        response: {
          200: issueListResponseSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listIssues(request.user),
  );

  app.get(
    '/issues/:id',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['receipts'],
        params: idParamsSchema,
        response: {
          200: issueSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.getIssue(request.user, request.params.id),
  );

  app.post(
    '/issues/:id/resolve',
    {
      preValidation: app.requireRole('dispatcher'),
      schema: {
        tags: ['receipts'],
        params: idParamsSchema,
        body: resolveIssueRequestSchema,
        response: {
          200: issueSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) => service.resolveIssue(request.user, request.params.id, request.body),
  );
};
