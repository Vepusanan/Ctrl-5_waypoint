import { and, asc, eq, inArray, or, savedViews, sql } from '@waypoint/database';
import {
  apiErrorSchema,
  createSavedViewRequestSchema,
  idParamsSchema,
  orderSavedViewsRequestSchema,
  type SavedView,
  savedViewListSchema,
  savedViewSchema,
  updateSavedViewRequestSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError } from '../../plugins/errors.ts';

// Saved planning-queue views (UI-D02). A dispatcher sees their own views and every team view,
// and can only change the ones they own.

const errors = { 400: apiErrorSchema, 401: apiErrorSchema, 403: apiErrorSchema };
const MISSING = 'That view no longer exists';
const MAX_VIEWS = 50;

const columns = {
  id: savedViews.id,
  name: savedViews.name,
  audience: savedViews.audience,
  pinned: savedViews.pinned,
  filters: savedViews.filters,
};

function toView(row: {
  id: string;
  name: string;
  audience: string;
  pinned: boolean;
  filters: Record<string, unknown>;
}): SavedView {
  return { ...row, audience: row.audience === 'team' ? 'team' : 'private' };
}

export const savedViewRoutes: FastifyPluginAsyncZod = async (app) => {
  const visible = (userId: string) =>
    or(eq(savedViews.userId, userId), eq(savedViews.audience, 'team'));
  const list = async (userId: string) => {
    const rows = await app.db
      .select(columns)
      .from(savedViews)
      .where(visible(userId))
      .orderBy(asc(savedViews.position), asc(savedViews.createdAt));
    const items = rows.map(toView);
    return { items, total: items.length };
  };
  const owner = (request: { user: { id: string } | null }) => {
    if (request.user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
    return request.user.id;
  };

  app.get(
    '/planning/views',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: { tags: ['planning'], response: { 200: savedViewListSchema, ...errors } },
    },
    async (request) => list(owner(request)),
  );

  app.post(
    '/planning/views',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['planning'],
        body: createSavedViewRequestSchema,
        response: { 201: savedViewSchema, ...errors, 422: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = owner(request);
      const [count] = await app.db
        .select({
          total: sql<number>`count(*)::int`,
          last: sql<number>`coalesce(max(${savedViews.position}), 0)::int`,
        })
        .from(savedViews)
        .where(eq(savedViews.userId, userId));
      if ((count?.total ?? 0) >= MAX_VIEWS) {
        throw new ApiError('CONSTRAINT_VIOLATION', `You can keep up to ${MAX_VIEWS} saved views`);
      }
      const [created] = await app.db
        .insert(savedViews)
        .values({ ...request.body, userId, position: (count?.last ?? 0) + 1 })
        .returning(columns);
      if (created === undefined) throw new ApiError('INTERNAL_ERROR', 'View was not saved');
      return reply.code(201).send(toView(created));
    },
  );

  app.patch(
    '/planning/views/:id',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['planning'],
        params: idParamsSchema,
        body: updateSavedViewRequestSchema,
        response: { 200: savedViewSchema, ...errors, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const { name, audience, pinned, filters } = request.body;
      const [updated] = await app.db
        .update(savedViews)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(audience !== undefined ? { audience } : {}),
          ...(pinned !== undefined ? { pinned } : {}),
          ...(filters !== undefined ? { filters } : {}),
          // An empty patch still has to be a valid UPDATE.
          userId: owner(request),
        })
        .where(and(eq(savedViews.id, request.params.id), eq(savedViews.userId, owner(request))))
        .returning(columns);
      if (updated === undefined) throw new ApiError('NOT_FOUND', MISSING);
      return toView(updated);
    },
  );

  app.delete(
    '/planning/views/:id',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['planning'],
        params: idParamsSchema,
        response: { 204: z.null(), ...errors, 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const removed = await app.db
        .delete(savedViews)
        .where(and(eq(savedViews.id, request.params.id), eq(savedViews.userId, owner(request))))
        .returning({ id: savedViews.id });
      if (removed.length === 0) throw new ApiError('NOT_FOUND', MISSING);
      return reply.code(204).send(null);
    },
  );

  // The order is the dispatcher's own, so only their views move. Team views from others keep
  // their place.
  app.put(
    '/planning/views/order',
    {
      preHandler: app.requireRole('dispatcher'),
      schema: {
        tags: ['planning'],
        body: orderSavedViewsRequestSchema,
        response: { 200: savedViewListSchema, ...errors },
      },
    },
    async (request) => {
      const userId = owner(request);
      const { ids } = request.body;
      await app.db.transaction(async (tx) => {
        if (ids.length === 0) return;
        const owned = await tx
          .select({ id: savedViews.id })
          .from(savedViews)
          .where(and(eq(savedViews.userId, userId), inArray(savedViews.id, ids)));
        const mine = new Set(owned.map((row) => row.id));
        let position = 0;
        for (const id of ids) {
          if (!mine.has(id)) continue;
          position += 1;
          await tx.update(savedViews).set({ position }).where(eq(savedViews.id, id));
        }
      });
      return list(userId);
    },
  );
};
