import rateLimit from '@fastify/rate-limit';
import { apiErrorSchema, currentUserResponseSchema, loginRequestSchema } from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ApiError } from '../../plugins/errors.ts';
import { everyRole } from '../../plugins/rbac.ts';
import { clearSessionCookieOptions, SESSION_COOKIE, sessionCookieOptions } from './cookies.ts';

// SYSTEM_DESIGN §9.1: ten sign-in attempts a minute per address unless the deploy sets another.
const DEFAULT_LOGIN_LIMIT = 10;

export const authRoutes: FastifyPluginAsyncZod<{ loginLimit?: number }> = async (app, options) => {
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/v1/auth/')) reply.header('Cache-Control', 'no-store');
  });
  const service = app.authService;
  const secure = app.secureCookies;

  await app.register(rateLimit, { global: false });

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: { max: options.loginLimit ?? DEFAULT_LOGIN_LIMIT, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        body: loginRequestSchema,
        response: {
          200: currentUserResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          429: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.login(request.body);
      reply.setCookie(SESSION_COOKIE, result.sessionId, sessionCookieOptions(secure));
      return { user: result.user };
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: app.requireRole(...everyRole()),
      schema: { tags: ['auth'] },
    },
    async (request, reply) => {
      await service.logout(request.user, request.sessionId);
      reply.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(secure));
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.requireRole(...everyRole()),
      schema: {
        tags: ['auth'],
        response: { 200: currentUserResponseSchema, 401: apiErrorSchema, 403: apiErrorSchema },
      },
    },
    async (request) => {
      if (request.user === null) {
        throw new ApiError('UNAUTHENTICATED', 'Sign in required');
      }
      return { user: request.user };
    },
  );
};
