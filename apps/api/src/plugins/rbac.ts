import { orders, outlets, tripStops, trips, vehicles } from '@waypoint/database';
import type { Role, User } from '@waypoint/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { preValidationHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { ApiError } from './errors.ts';

const allow = sql`true`;
const deny = sql`false`;

export interface ResourceScope {
  orders: SQL;
  trips: SQL;
}

function outletsAtDepot(depotId: string): SQL {
  return sql`${orders.outletId} in (select ${outlets.id} from ${outlets} where ${outlets.depotId} = ${depotId})`;
}

function vehiclesAtDepot(depotId: string): SQL {
  return sql`${trips.vehicleId} in (select ${vehicles.id} from ${vehicles} where ${vehicles.depotId} = ${depotId})`;
}

function orderScope(user: User): SQL {
  switch (user.role) {
    case 'store_manager':
      return eq(orders.outletId, user.outletId);
    case 'dispatcher':
      return user.depotId === null ? allow : outletsAtDepot(user.depotId);
    case 'loader':
      return outletsAtDepot(user.depotId);
    case 'driver':
      return deny;
  }
}

const published = sql`${trips.status} <> 'planned'`;

function tripScope(user: User): SQL {
  switch (user.role) {
    // Draft trips belong to the dispatcher until the plan is published.
    case 'driver':
      return sql`${trips.vehicleId} = ${user.vehicleId} and ${published}`;
    case 'loader':
      return sql`${vehiclesAtDepot(user.depotId)} and ${published}`;
    case 'dispatcher':
      return user.depotId === null ? allow : vehiclesAtDepot(user.depotId);
    case 'store_manager':
      return sql`${trips.id} in (
        select ${tripStops.tripId} from ${tripStops}
        inner join ${orders} on ${orders.id} = ${tripStops.orderId}
        where ${orders.outletId} = ${user.outletId}
      ) and ${published}`;
  }
}

// SYSTEM_DESIGN §9.3. Services AND this clause into every query. A miss is an empty
// result, which the service reports as 404 so out-of-scope records are indistinguishable
// from missing ones.
export function scope(user: User): ResourceScope {
  return { orders: orderScope(user), trips: tripScope(user) };
}

export function everyRole(): [Role, ...Role[]] {
  return ['dispatcher', 'loader', 'driver', 'store_manager'];
}

export const rbacPlugin = fp(
  async (app) => {
    const requireRole = (...roles: [Role, ...Role[]]): preValidationHookHandler => {
      return async (request) => {
        const user = request.user;
        if (user === null) {
          throw new ApiError('UNAUTHENTICATED', 'Sign in required');
        }
        if (!roles.includes(user.role)) {
          throw new ApiError('FORBIDDEN', 'You do not have access to this action');
        }
      };
    };
    app.decorate('requireRole', requireRole);
  },
  { name: 'rbac', dependencies: ['auth'] },
);
