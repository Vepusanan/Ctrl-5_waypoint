import {
  apiErrorSchema,
  calendarListResponseSchema,
  depotListResponseSchema,
  districtTravelListResponseSchema,
  listCalendarQuerySchema,
  listDistrictTravelQuerySchema,
  listOutletsQuerySchema,
  listServiceAllowancesQuerySchema,
  listVehiclesQuerySchema,
  outletListResponseSchema,
  outletParamsSchema,
  outletSchema,
  serviceAllowanceListResponseSchema,
  vehicleDetailQuerySchema,
  vehicleListResponseSchema,
  vehicleParamsSchema,
  vehicleReferenceSchema,
} from '@waypoint/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { everyRole } from '../../plugins/rbac.ts';
import { createReferenceService } from './service.ts';

const roles = everyRole();

export const referenceRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createReferenceService(app.db, app.clock);

  app.get(
    '/outlets',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        querystring: listOutletsQuerySchema,
        response: {
          200: outletListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listOutlets(request.user, request.query),
  );

  app.get(
    '/outlets/:id',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        params: outletParamsSchema,
        response: {
          200: outletSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.getOutlet(request.user, request.params.id),
  );

  app.get(
    '/vehicles',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        querystring: listVehiclesQuerySchema,
        response: {
          200: vehicleListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listVehicles(request.user, request.query),
  );

  app.get(
    '/vehicles/:id',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        params: vehicleParamsSchema,
        querystring: vehicleDetailQuerySchema,
        response: {
          200: vehicleReferenceSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => service.getVehicle(request.user, request.params.id, request.query),
  );

  app.get(
    '/depots',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        response: {
          200: depotListResponseSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listDepots(request.user),
  );

  app.get(
    '/calendar',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        querystring: listCalendarQuerySchema,
        response: {
          200: calendarListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listCalendar(request.user, request.query),
  );

  app.get(
    '/district-travel',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        querystring: listDistrictTravelQuerySchema,
        response: {
          200: districtTravelListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listDistrictTravel(request.user, request.query),
  );

  app.get(
    '/service-allowances',
    {
      preValidation: app.requireRole(...roles),
      schema: {
        tags: ['reference'],
        querystring: listServiceAllowancesQuerySchema,
        response: {
          200: serviceAllowanceListResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request) => service.listServiceAllowances(request.user, request.query),
  );
};
