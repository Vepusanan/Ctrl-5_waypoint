import multipart from '@fastify/multipart';
import {
  apiErrorSchema,
  deliveryStopSchema,
  idParamsSchema,
  podSchema,
  stopEventInputSchema,
  stopEventSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MAX_IMAGE_BYTES, MAX_POD_BODY_BYTES } from './images.ts';
import { createDeliveryService } from './service.ts';
import { readPodUpload } from './upload.ts';

const readRoles = ['dispatcher', 'driver'] as const;

export const deliveryRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: 2,
      fields: 4,
      fieldSize: 512,
    },
  });
  const service = createDeliveryService(app.db, app.audit, app.domainEvents, app.clock);

  app.get(
    '/stops/:id',
    {
      preValidation: app.requireRole(...readRoles),
      schema: {
        tags: ['deliveries'],
        params: idParamsSchema,
        response: {
          200: deliveryStopSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.get(request.user, request.params.id),
  );

  for (const kind of ['signature', 'photo'] as const) {
    app.get(
      `/stops/:id/pod/${kind}`,
      {
        preValidation: app.requireRole('dispatcher', 'driver', 'store_manager'),
        schema: {
          tags: ['deliveries'],
          params: idParamsSchema,
          // The body is the image itself, so there is no JSON response schema.
        },
      },
      async (request, reply) => {
        const image = await service.podImage(request.user, request.params.id, kind);
        return reply
          .header('content-type', image.contentType)
          .header('cache-control', 'private, max-age=3600')
          .send(image.bytes);
      },
    );
  }

  app.post(
    '/stops/:id/events',
    {
      preValidation: app.requireRole('driver'),
      schema: {
        tags: ['deliveries'],
        params: idParamsSchema,
        body: stopEventInputSchema,
        response: {
          200: stopEventSchema,
          201: stopEventSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.recordEvent(request.user, request.params.id, request.body);
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result.event);
    },
  );

  app.post(
    '/stops/:id/pod',
    {
      // Two images, each under the 2 MB file limit, plus multipart framing.
      bodyLimit: MAX_POD_BODY_BYTES,
      preValidation: app.requireRole('driver'),
      schema: {
        tags: ['deliveries'],
        params: idParamsSchema,
        response: {
          201: podSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const upload = await readPodUpload(request.parts());
      const pod = await service.recordPod(request.user, request.params.id, upload);
      return reply.code(201).send(pod);
    },
  );
};
