import type { Database } from '@waypoint/database';
import {
  and,
  asc,
  auditLog,
  deferrals,
  desc,
  eq,
  fuelLedger,
  inArray,
  loadingCounts,
  loadingRecords,
  notifications,
  orders,
  planningRuns,
  sql,
  tripStops,
  trips,
  vehicleAvailability,
} from '@waypoint/database';
import { describeAssignment, type TripDraft, validatePlan } from '@waypoint/planning';
import {
  type MarkVehicleUnavailableRequest,
  type OrderStatus,
  orderStateMachine,
  type ReasonCode,
  type ReplanProposal,
  type ReplanRequest,
  type ReplanResponse,
  type TripNo,
  type TripStatus,
  tripStateMachine,
  type User,
  type VehicleUnavailableResponse,
} from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEventBus, PlanningDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import {
  draftsReferencing,
  loadPlanningContext,
  type PlanningContext,
  validatorInput,
} from './assemble.ts';
import { createPlanningRepo, type PlanningDb, type PlanningRepo } from './repo.ts';
import { arrivalDate, constraint, planFromEngine } from './service.ts';

// SRS §24 and §42: a published plan can still change before a vehicle leaves. A replan moves
// orders between trips or defers them, revalidates every hard rule, and publishes the next plan
// version. Trips that have departed and stops that have an outcome are facts and never change.

const NOT_PUBLISHED = 'Only a published plan can be replanned. Change the draft instead.';
const STALE = 'Plan version is stale';
const MISSING_VEHICLE = 'Vehicle not found';
const MISSING_ORDER = 'Order not found';
const NOTHING = 'The replan does not change the plan';
const REASON_REQUIRED = 'A deferral needs a reason code';
const TRIP_CHANGED = 'A trip changed while the vehicle was being marked unavailable. Try again.';

/** A trip the loader has not released yet. Its orders are still at the depot. */
const MOVABLE_SOURCE: readonly TripStatus[] = ['published', 'loading', 'blocked'];
/** A trip that can still take another order. */
const OPEN_TARGET: readonly TripStatus[] = ['published', 'loading'];
/** Trips that stop when their vehicle is lost. Departed trips are already on the road. */
const BLOCKABLE: readonly TripStatus[] = ['published', 'loading', 'ready'];

type Dispatcher = Extract<User, { role: 'dispatcher' }>;

interface RunTrip {
  id: string;
  vehicleId: string;
  tripNo: TripNo;
  status: TripStatus;
  version: number;
  hasLoading: boolean;
  stops: { id: string; orderId: string; seq: number; status: string }[];
}

interface PublishedRun {
  id: string;
  depotId: string;
  serviceDate: string;
  planVersion: number;
  trips: RunTrip[];
}

export interface ReplanService {
  markUnavailable(
    user: User | null,
    vehicleId: string,
    input: MarkVehicleUnavailableRequest,
  ): Promise<VehicleUnavailableResponse>;
  proposal(user: User | null, serviceDate: string, vehicleId: string): Promise<ReplanProposal>;
  apply(
    user: User | null,
    serviceDate: string,
    version: number,
    input: ReplanRequest,
  ): Promise<ReplanResponse>;
}

export function createReplanService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: PlanningRepo = createPlanningRepo(),
): ReplanService {
  return {
    async markUnavailable(user, vehicleId, input) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      const now = clock.now();
      const pending: PlanningDomainEvent[] = [];
      const result = await db.transaction(async (tx) => {
        const vehicle = (await repo.listDepotVehicles(tx, depotId)).find(
          (row) => row.id === vehicleId,
        );
        if (vehicle === undefined) throw new ApiError('NOT_FOUND', MISSING_VEHICLE);
        // Trips first, then availability: the order a departure takes them in.
        const run = await findRun(tx, depotId, input.date, true);
        await tx
          .insert(vehicleAvailability)
          .values({ vehicleId, date: input.date, status: 'in_workshop' })
          .onConflictDoUpdate({
            target: [vehicleAvailability.vehicleId, vehicleAvailability.date],
            set: { status: 'in_workshop' },
          });

        const blocked: RunTrip[] = [];
        const affected: string[] = [];
        if (run !== null) {
          for (const trip of run.trips) {
            if (trip.vehicleId !== vehicleId || !BLOCKABLE.includes(trip.status)) continue;
            tripStateMachine.assertTransition(trip.status, 'blocked');
            const stopped = await tx
              .update(trips)
              .set({ status: 'blocked', version: trip.version + 1 })
              .where(
                and(
                  eq(trips.id, trip.id),
                  eq(trips.status, trip.status),
                  eq(trips.version, trip.version),
                ),
              )
              .returning({ id: trips.id });
            if (stopped.length === 0) throw new ApiError('VERSION_CONFLICT', TRIP_CHANGED);
            blocked.push(trip);
            for (const stop of trip.stops) affected.push(stop.orderId);
          }
          // Goods already being loaded come back off the vehicle with it.
          if (affected.length > 0) {
            orderStateMachine.assertTransition('loading', 'allocated');
            await tx
              .update(orders)
              .set({ status: 'allocated', version: sql`${orders.version} + 1` })
              .where(and(inArray(orders.id, affected), eq(orders.status, 'loading')));
          }
          await notifyTrips(
            repo,
            tx,
            depotId,
            blocked.map((trip) => ({ id: trip.id, vehicleId: trip.vehicleId })),
            now,
          );
        }
        await audit.record(tx, {
          actorId: dispatcher.id,
          role: dispatcher.role,
          action: 'vehicle.unavailable',
          entityType: 'vehicle',
          entityId: vehicleId,
          before: { status: 'available' },
          after: {
            status: 'in_workshop',
            date: input.date,
            reason: input.reason ?? null,
            blockedTripIds: blocked.map((trip) => trip.id),
            affectedOrderIds: affected,
          },
          createdAt: now,
        });
        if (run !== null) {
          pending.push(planEvent(dispatcher.id, now, depotId, input.date, run.id));
        }
        return {
          vehicleId,
          date: input.date,
          blockedTripIds: blocked.map((trip) => trip.id),
          affectedOrderIds: affected,
        };
      });
      for (const event of pending) events.publish(event);
      return result;
    },

    async proposal(user, serviceDate, vehicleId) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      return db.transaction(async (tx) => {
        const run = await findRun(tx, depotId, serviceDate, false);
        if (run === null) throw new ApiError('CONSTRAINT_VIOLATION', NOT_PUBLISHED);
        const context = await replanContext(repo, tx, dispatcher, run, []);
        if (!context.vehiclesById.has(vehicleId)) {
          throw new ApiError('NOT_FOUND', MISSING_VEHICLE);
        }
        const marked = await lastUnavailable(tx, vehicleId, serviceDate);
        const stranded = run.trips.filter(
          (trip) => trip.vehicleId === vehicleId && trip.status === 'blocked',
        );
        const drafts = liveDrafts(run, context);
        const byId = new Map(context.orders.map((order) => [order.id, order]));
        const rows: ReplanProposal['orders'] = [];
        // Heaviest first: the orders that are hardest to place choose before the rest.
        const waiting = stranded
          .flatMap((trip) =>
            trip.stops
              .filter((stop) => stop.status === 'pending')
              .map((stop) => ({ trip, order: byId.get(stop.orderId) })),
          )
          .sort((left, right) => (right.order?.weightKg ?? 0) - (left.order?.weightKg ?? 0));
        for (const { trip, order } of waiting) {
          if (order === undefined) continue;
          const placed = place(context, run, drafts, order.id);
          rows.push({
            orderId: order.id,
            outletId: order.outletId,
            temp: order.temp,
            weightKg: order.weightKg,
            from: { vehicleId: trip.vehicleId, tripNo: trip.tripNo, tripStatus: trip.status },
            target: placed.target,
            blockedBy: placed.blockedBy,
          });
        }
        return {
          serviceDate,
          vehicleId,
          planVersion: run.planVersion,
          markedAt: marked === null ? null : formatColomboTimestamp(marked.at),
          reason: marked?.reason ?? null,
          feasible: rows.every((row) => row.target !== null),
          orders: rows,
        };
      });
    },

    async apply(user, serviceDate, version, input) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      const now = clock.now();
      const pending: PlanningDomainEvent[] = [];
      const response = await db.transaction(async (tx) => {
        const run = await findRun(tx, depotId, serviceDate, true);
        if (run === null) throw new ApiError('CONSTRAINT_VIOLATION', NOT_PUBLISHED);
        if (run.planVersion !== version) throw new ApiError('VERSION_CONFLICT', STALE);

        const context = await replanContext(
          repo,
          tx,
          dispatcher,
          run,
          input.moves.map((move) => move.orderId),
        );
        const orderById = new Map(context.orders.map((order) => [order.id, order]));
        const stopByOrder = new Map<string, { trip: RunTrip; stopId: string; status: string }>();
        for (const trip of run.trips) {
          for (const stop of trip.stops) {
            stopByOrder.set(stop.orderId, { trip, stopId: stop.id, status: stop.status });
          }
        }
        const tripByKey = new Map(run.trips.map((trip) => [key(trip), trip]));

        const drafts = new Map<string, TripDraft>();
        for (const draft of liveDrafts(run, context)) drafts.set(key(draft), draft);
        const before = new Map([...drafts].map(([name, draft]) => [name, [...draft.orderIds]]));

        const moved: { orderId: string; from: string | null; to: string }[] = [];
        const deferred: { orderId: string; from: string | null; reason: ReasonCode }[] = [];
        for (const move of input.moves) {
          const order = orderById.get(move.orderId);
          if (order === undefined) throw new ApiError('NOT_FOUND', MISSING_ORDER);
          const current = stopByOrder.get(move.orderId);
          if (current === undefined) {
            // An order this run deferred can be put back on a trip, nothing else.
            if (order.status !== 'deferred' || !(await deferredHere(tx, run.id, order.id))) {
              throw new ApiError('CONSTRAINT_VIOLATION', 'Order is not part of this plan');
            }
            if (move.target === null) {
              throw new ApiError('CONSTRAINT_VIOLATION', 'Order is already deferred');
            }
          } else {
            if (current.status !== 'pending' || !MOVABLE_SOURCE.includes(current.trip.status)) {
              throw new ApiError(
                'CONSTRAINT_VIOLATION',
                `${current.trip.vehicleId} trip ${current.trip.tripNo} is ${current.trip.status}. Its stops can no longer change.`,
              );
            }
          }
          const from = current === undefined ? null : key(current.trip);
          // Naming the trip the order is already on changes nothing.
          if (move.target !== null && key(move.target) === from) continue;
          if (from !== null) {
            const source = drafts.get(from);
            if (source !== undefined) {
              source.orderIds = source.orderIds.filter((id) => id !== move.orderId);
            }
          }
          if (move.target === null) {
            if (move.reasonCode === undefined) {
              throw new ApiError('VALIDATION_ERROR', REASON_REQUIRED);
            }
            deferred.push({ orderId: move.orderId, from, reason: move.reasonCode });
            continue;
          }
          const to = key(move.target);
          const vehicle = context.vehiclesById.get(move.target.vehicleId);
          if (vehicle === undefined) throw new ApiError('NOT_FOUND', MISSING_VEHICLE);
          const existing = tripByKey.get(to);
          if (existing !== undefined && !OPEN_TARGET.includes(existing.status)) {
            throw new ApiError(
              'CONSTRAINT_VIOLATION',
              `${existing.vehicleId} trip ${existing.tripNo} is ${existing.status} and cannot take another order`,
            );
          }
          const target = drafts.get(to) ?? { ...move.target, orderIds: [] };
          target.orderIds = [...target.orderIds, move.orderId];
          drafts.set(to, target);
          moved.push({ orderId: move.orderId, from, to });
        }
        if (moved.length === 0 && deferred.length === 0) {
          throw new ApiError('CONSTRAINT_VIOLATION', NOTHING);
        }

        // A trip that takes on orders visits the earliest-opening outlets first, so its planned
        // arrivals still run in stop order. If that order breaks a rule the appended one is kept.
        const gained = new Set(moved.map((item) => item.to));
        const appended = [...drafts.values()].filter((draft) => draft.orderIds.length > 0);
        const sequenced = appended.map((draft) =>
          gained.has(key(draft))
            ? { ...draft, orderIds: byWindow(context, draft.orderIds) }
            : draft,
        );
        const check = (candidate: TripDraft[]) => {
          const scoped = planFor(context, candidate);
          return {
            scoped,
            violations: validatePlan(
              validatorInput(scoped, draftsReferencing(scoped, candidate)),
              candidate,
            ),
          };
        };
        let next = sequenced;
        let { scoped: planned, violations } = check(next);
        if (violations.length > 0) {
          next = appended;
          ({ scoped: planned, violations } = check(next));
        }
        if (violations.length > 0) throw constraint(violations);
        for (const draft of next) drafts.set(key(draft), draft);
        const described = planFromEngine(() => describeAssignment(planned.plan, next));

        // Only trips whose order list changed are rewritten.
        const changedKeys = new Set<string>();
        for (const [name, draft] of drafts) {
          const earlier = before.get(name) ?? [];
          if (earlier.join() !== draft.orderIds.join()) changedKeys.add(name);
        }

        // Stops leave their old trip first, so no trip holds two stops with one sequence number.
        for (const item of deferred) {
          const current = stopByOrder.get(item.orderId);
          if (current !== undefined) {
            await tx.delete(tripStops).where(eq(tripStops.id, current.stopId));
          }
        }
        const changedTripIds: string[] = [];
        const tripIdByKey = new Map<string, string>();
        for (const name of changedKeys) {
          const existing = tripByKey.get(name);
          if (existing !== undefined) {
            tripIdByKey.set(name, existing.id);
            await tx
              .update(tripStops)
              .set({ seq: sql`${tripStops.seq} + 1000` })
              .where(eq(tripStops.tripId, existing.id));
          }
        }
        for (const name of changedKeys) {
          const draft = drafts.get(name);
          if (draft === undefined || draft.orderIds.length === 0) continue;
          const plan = described.trips.find((trip) => key(trip) === name);
          if (plan === undefined) throw new ApiError('INTERNAL_ERROR', 'Replanned trip is missing');
          let tripId = tripIdByKey.get(name);
          if (tripId === undefined) {
            tripStateMachine.assertTransition('planned', 'published');
            const created = await tx
              .insert(trips)
              .values({
                runId: run.id,
                vehicleId: plan.vehicleId,
                tripNo: plan.tripNo,
                brand: plan.brand,
                district: plan.district,
                status: 'published',
                version: 1,
                plannedMinutes: plan.minutes,
                plannedKm: plan.km,
              })
              .returning({ id: trips.id });
            tripId = created[0]?.id;
            if (tripId === undefined) throw new ApiError('INTERNAL_ERROR', 'Trip was not created');
            tripIdByKey.set(name, tripId);
            await tx.insert(fuelLedger).values({
              vehicleId: plan.vehicleId,
              isoYear: context.isoYear,
              isoWeek: context.isoWeek,
              tripId,
              litres: plan.litres,
            });
          } else {
            await tx
              .update(trips)
              .set({
                plannedMinutes: plan.minutes,
                plannedKm: plan.km,
                version: sql`${trips.version} + 1`,
              })
              .where(eq(trips.id, tripId));
            await tx
              .update(fuelLedger)
              .set({ litres: plan.litres })
              .where(eq(fuelLedger.tripId, tripId));
          }
          changedTripIds.push(tripId);
        }
        // Second pass: every stop takes its place on its (possibly new) trip.
        for (const name of changedKeys) {
          const tripId = tripIdByKey.get(name);
          const plan = described.trips.find((trip) => key(trip) === name);
          if (tripId === undefined || plan === undefined) continue;
          for (const stop of plan.stops) {
            const current = stopByOrder.get(stop.orderId);
            if (current === undefined) {
              await tx.insert(tripStops).values({
                tripId,
                orderId: stop.orderId,
                seq: stop.seq,
                plannedArrival: arrivalDate(stop.plannedArrival),
              });
            } else {
              await tx
                .update(tripStops)
                .set({ tripId, seq: stop.seq, plannedArrival: arrivalDate(stop.plannedArrival) })
                .where(eq(tripStops.id, current.stopId));
            }
          }
        }
        // A trip left with no stops is removed, unless loading records already point at it.
        for (const name of changedKeys) {
          const existing = tripByKey.get(name);
          const draft = drafts.get(name);
          if (existing === undefined || (draft !== undefined && draft.orderIds.length > 0)) {
            continue;
          }
          await tx.delete(fuelLedger).where(eq(fuelLedger.tripId, existing.id));
          if (existing.hasLoading) {
            if (existing.status !== 'blocked') {
              await tx
                .update(trips)
                .set({ status: 'blocked', version: existing.version + 1 })
                .where(eq(trips.id, existing.id));
            }
          } else {
            await tx.delete(trips).where(eq(trips.id, existing.id));
          }
        }
        // Emptied blocked trips of a lost vehicle were never in `drafts`, so sweep them too.
        for (const trip of run.trips) {
          if (trip.status !== 'blocked' || changedKeys.has(key(trip))) continue;
          const left = trip.stops.filter(
            (stop) =>
              !moved.some((item) => item.orderId === stop.orderId) &&
              !deferred.some((item) => item.orderId === stop.orderId),
          );
          if (left.length > 0 || trip.stops.length === 0) continue;
          await tx.delete(fuelLedger).where(eq(fuelLedger.tripId, trip.id));
          if (!trip.hasLoading) await tx.delete(trips).where(eq(trips.id, trip.id));
        }

        // Order status follows the trip the order is now on.
        for (const item of moved) {
          const order = orderById.get(item.orderId);
          const target = tripByKey.get(item.to);
          const status: OrderStatus = target?.status === 'loading' ? 'loading' : 'allocated';
          if (order === undefined) continue;
          // A deferred order is allocated again before it can join a trip that is loading.
          const held = order.status === 'deferred' ? 'allocated' : order.status;
          if (order.status === 'deferred') orderStateMachine.assertTransition('deferred', held);
          if (held !== status) orderStateMachine.assertTransition(held, status);
          await tx
            .update(orders)
            .set({ status, version: sql`${orders.version} + 1` })
            .where(eq(orders.id, item.orderId));
          if (item.from !== null) {
            const source = tripByKey.get(item.from);
            if (source !== undefined) {
              await tx
                .delete(loadingCounts)
                .where(
                  and(eq(loadingCounts.tripId, source.id), eq(loadingCounts.orderId, item.orderId)),
                );
            }
          }
        }
        for (const item of deferred) {
          const order = orderById.get(item.orderId);
          if (order === undefined) continue;
          orderStateMachine.assertTransition(order.status, 'deferred');
          await tx
            .update(orders)
            .set({ status: 'deferred', version: sql`${orders.version} + 1` })
            .where(eq(orders.id, item.orderId));
          const source = item.from === null ? undefined : tripByKey.get(item.from);
          await repo.insertDeferrals(tx, run.id, [
            {
              orderId: item.orderId,
              reasonCode: item.reason,
              type: source?.status === 'blocked' ? 'unavoidable' : 'prioritized',
              note: input.note,
              actorId: dispatcher.id,
              createdAt: now,
            },
          ]);
          await audit.record(tx, {
            actorId: dispatcher.id,
            role: dispatcher.role,
            action: 'order.deferred',
            entityType: 'order',
            entityId: item.orderId,
            before: { status: order.status },
            after: {
              status: 'deferred',
              reasonCode: item.reason,
              explain: input.note,
              runId: run.id,
              replan: true,
            },
            createdAt: now,
          });
        }

        const bumped = await tx
          .update(planningRuns)
          .set({ planVersion: run.planVersion + 1 })
          .where(and(eq(planningRuns.id, run.id), eq(planningRuns.planVersion, run.planVersion)))
          .returning({ planVersion: planningRuns.planVersion });
        const planVersion = bumped[0]?.planVersion;
        if (planVersion === undefined) throw new ApiError('VERSION_CONFLICT', STALE);

        const touched = [...changedKeys]
          .map((name) => ({ id: tripIdByKey.get(name), vehicleId: name.split('#')[0] ?? '' }))
          .filter(
            (trip): trip is { id: string; vehicleId: string } =>
              trip.id !== undefined && changedTripIds.includes(trip.id),
          );
        await notifyTrips(repo, tx, depotId, touched, now);
        await notifyStores(
          repo,
          tx,
          [
            ...moved.map((item) => ({ orderId: item.orderId, type: 'plan_changed' as const })),
            ...deferred.map((item) => ({ orderId: item.orderId, type: 'order_deferred' as const })),
          ],
          orderById,
          now,
        );
        await audit.record(tx, {
          actorId: dispatcher.id,
          role: dispatcher.role,
          action: 'plan.replanned',
          entityType: 'planning_run',
          entityId: run.id,
          before: { planVersion: run.planVersion },
          after: {
            planVersion,
            note: input.note,
            movedOrderIds: moved.map((item) => item.orderId),
            deferredOrderIds: deferred.map((item) => item.orderId),
            moves: [
              ...moved.map((item) => ({ orderId: item.orderId, from: item.from, to: item.to })),
              ...deferred.map((item) => ({ orderId: item.orderId, from: item.from, to: null })),
            ],
          },
          createdAt: now,
        });
        pending.push(planEvent(dispatcher.id, now, depotId, serviceDate, run.id));
        for (const item of deferred) {
          const order = orderById.get(item.orderId);
          pending.push({
            ...planEvent(dispatcher.id, now, depotId, serviceDate, run.id),
            type: 'order.deferred',
            orderId: item.orderId,
            ...(order ? { outletId: order.outletId } : {}),
          });
        }
        return {
          planVersion,
          movedOrderIds: moved.map((item) => item.orderId),
          deferredOrderIds: deferred.map((item) => item.orderId),
          changedTripIds,
        };
      });
      for (const event of pending) events.publish(event);
      return response;
    },
  };
}

const key = (trip: { vehicleId: string; tripNo: number }) => `${trip.vehicleId}#${trip.tripNo}`;

function assertDispatcher(user: User | null): Dispatcher {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function requireDepot(user: Dispatcher): string {
  if (user.depotId === null) {
    throw new ApiError('VALIDATION_ERROR', 'This dispatcher has no depot to plan for');
  }
  return user.depotId;
}

function asTripNo(value: number): TripNo {
  if (value === 1 || value === 2) return value;
  throw new ApiError('INTERNAL_ERROR', 'Trip number is invalid');
}

/** The published run with its trips and stops, or null when the plan is not published. */
async function findRun(
  db: PlanningDb,
  depotId: string,
  serviceDate: string,
  lock: boolean,
): Promise<PublishedRun | null> {
  const query = db
    .select()
    .from(planningRuns)
    .where(and(eq(planningRuns.depotId, depotId), eq(planningRuns.serviceDate, serviceDate)))
    .limit(1);
  const rows = lock ? await query.for('update') : await query;
  const run = rows[0];
  if (run === undefined || run.status !== 'published') return null;
  // Loading and departure lock the trip row, not the run. A replan takes the same locks, so it
  // waits for a Ready or a departure in flight and then decides on the trip as it now stands.
  const tripQuery = db
    .select({
      id: trips.id,
      vehicleId: trips.vehicleId,
      tripNo: trips.tripNo,
      status: trips.status,
      version: trips.version,
    })
    .from(trips)
    .where(eq(trips.runId, run.id))
    .orderBy(asc(trips.vehicleId), asc(trips.tripNo));
  const tripRows = lock ? await tripQuery.for('update') : await tripQuery;
  const ids = tripRows.map((trip) => trip.id);
  const stopRows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: tripStops.id,
            tripId: tripStops.tripId,
            orderId: tripStops.orderId,
            seq: tripStops.seq,
            status: tripStops.status,
          })
          .from(tripStops)
          .where(inArray(tripStops.tripId, ids))
          .orderBy(asc(tripStops.seq));
  const loading =
    ids.length === 0
      ? []
      : await db
          .select({ tripId: loadingRecords.tripId })
          .from(loadingRecords)
          .where(inArray(loadingRecords.tripId, ids));
  const hasLoading = new Set(loading.map((row) => row.tripId));
  return {
    id: run.id,
    depotId: run.depotId,
    serviceDate: run.serviceDate,
    planVersion: run.planVersion,
    trips: tripRows.map((trip) => ({
      ...trip,
      tripNo: asTripNo(trip.tripNo),
      hasLoading: hasLoading.has(trip.id),
      stops: stopRows.filter((stop) => stop.tripId === trip.id),
    })),
  };
}

/**
 * Planning context for every order on the run plus the orders being moved. Fuel already booked
 * for this run's trips is handed back, so the validator does not count it twice.
 */
async function replanContext(
  repo: PlanningRepo,
  db: PlanningDb,
  dispatcher: Dispatcher,
  run: PublishedRun,
  extraOrderIds: readonly string[],
): Promise<PlanningContext> {
  const orderIds = [
    ...new Set([
      ...run.trips.flatMap((trip) => trip.stops.map((stop) => stop.orderId)),
      ...extraOrderIds,
    ]),
  ];
  const rows = await repo.listOrdersByIds(db, orderIds, scope(dispatcher).orders);
  const context = await loadPlanningContext(
    repo,
    db,
    run.depotId,
    run.serviceDate,
    scope(dispatcher).orders,
    rows,
  );
  const tripIds = run.trips.map((trip) => trip.id);
  if (tripIds.length > 0) {
    const booked = await db
      .select({ vehicleId: fuelLedger.vehicleId, litres: fuelLedger.litres })
      .from(fuelLedger)
      .where(inArray(fuelLedger.tripId, tripIds));
    for (const row of booked) {
      const remaining = context.plan.fuelRemainingL[row.vehicleId];
      if (remaining !== undefined) {
        context.plan.fuelRemainingL[row.vehicleId] = remaining + row.litres;
      }
    }
  }
  return context;
}

/** Trips that still run: not blocked, and on a vehicle that is still available. */
function liveDrafts(run: PublishedRun, context: PlanningContext): TripDraft[] {
  const drafts: TripDraft[] = [];
  for (const trip of run.trips) {
    if (trip.status === 'blocked' || trip.stops.length === 0) continue;
    if (context.availability[trip.vehicleId] === 'in_workshop') continue;
    drafts.push({
      vehicleId: trip.vehicleId,
      tripNo: trip.tripNo,
      orderIds: trip.stops.map((stop) => stop.orderId),
    });
  }
  return drafts;
}

/** Orders by the time their outlet starts receiving, keeping the given order for ties. */
function byWindow(context: PlanningContext, orderIds: readonly string[]): string[] {
  const opens = (orderId: string) => {
    const order = context.plan.orders.find((row) => row.id === orderId);
    return order ? (context.plan.outlets[order.outletId]?.window.open ?? '') : '';
  };
  return orderIds
    .map((orderId, index) => ({ orderId, index, open: opens(orderId) }))
    .sort((left, right) => left.open.localeCompare(right.open) || left.index - right.index)
    .map((row) => row.orderId);
}

/** The context narrowed to the orders the drafts carry, so the engine defers nothing itself. */
function planFor(context: PlanningContext, drafts: readonly TripDraft[]): PlanningContext {
  const carried = new Set(drafts.flatMap((draft) => draft.orderIds));
  return {
    ...context,
    plan: { ...context.plan, orders: context.plan.orders.filter((order) => carried.has(order.id)) },
  };
}

/**
 * First trip that can take the order and still pass every hard rule: a trip already going to
 * that brand and district, then a new trip on the least capable vehicle that fits. The chosen
 * draft is updated in place so the next order sees the load.
 */
function place(
  context: PlanningContext,
  run: PublishedRun,
  drafts: TripDraft[],
  orderId: string,
): Pick<ReplanProposal['orders'][number], 'target' | 'blockedBy'> {
  const order = context.orders.find((row) => row.id === orderId);
  if (order === undefined) return { target: null, blockedBy: null };
  const statusByKey = new Map(run.trips.map((trip) => [key(trip), trip.status]));
  const candidates: { draft: TripDraft; newTrip: boolean }[] = [];
  for (const draft of drafts) {
    const status = statusByKey.get(key(draft));
    // A trip created earlier in this proposal has no status yet and is open.
    if (status !== undefined && !OPEN_TARGET.includes(status)) continue;
    const first = context.orders.find((row) => row.id === draft.orderIds[0]);
    if (first?.brand !== order.brand || first.district !== order.district) continue;
    candidates.push({ draft, newTrip: status === undefined });
  }
  const capability = (id: string) => {
    const vehicle = context.vehiclesById.get(id);
    return (vehicle?.temp === 'reefer' ? 2 : 0) + (vehicle?.type === 'van' ? 1 : 0);
  };
  const free = [...context.plan.vehicles].sort(
    (left, right) => capability(left.id) - capability(right.id) || left.id.localeCompare(right.id),
  );
  for (const vehicle of free) {
    for (const tripNo of [1, 2] as const) {
      const name = key({ vehicleId: vehicle.id, tripNo });
      if (statusByKey.has(name) || drafts.some((draft) => key(draft) === name)) continue;
      candidates.push({ draft: { vehicleId: vehicle.id, tripNo, orderIds: [] }, newTrip: true });
    }
  }
  let blockedBy: ReasonCode | null = null;
  for (const candidate of candidates) {
    const trial = drafts
      .filter((draft) => key(draft) !== key(candidate.draft))
      .concat({ ...candidate.draft, orderIds: [...candidate.draft.orderIds, orderId] });
    const planned = planFor(context, trial);
    const violations = validatePlan(
      validatorInput(planned, draftsReferencing(planned, trial)),
      trial,
    );
    if (violations.length > 0) {
      blockedBy = violations[0]?.rule ?? blockedBy;
      continue;
    }
    const described = describeAssignment(planned.plan, trial);
    const trip = described.trips.find((item) => key(item) === key(candidate.draft));
    const existing = drafts.find((draft) => key(draft) === key(candidate.draft));
    if (existing) existing.orderIds = [...existing.orderIds, orderId];
    else drafts.push({ ...candidate.draft, orderIds: [orderId] });
    return {
      target: {
        vehicleId: candidate.draft.vehicleId,
        tripNo: candidate.draft.tripNo,
        newTrip: candidate.newTrip && existing === undefined,
        loadPercent: Math.round(
          Math.max(trip?.utilization.weight ?? 0, trip?.utilization.volume ?? 0) * 100,
        ),
      },
      blockedBy: null,
    };
  }
  return { target: null, blockedBy: blockedBy ?? 'VEHICLE_UNAVAILABLE' };
}

async function deferredHere(db: PlanningDb, runId: string, orderId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deferrals.id })
    .from(deferrals)
    .where(and(eq(deferrals.runId, runId), eq(deferrals.orderId, orderId)))
    .limit(1);
  return rows.length > 0;
}

async function lastUnavailable(
  db: PlanningDb,
  vehicleId: string,
  date: string,
): Promise<{ at: Date; reason: string | null } | null> {
  const rows = await db
    .select({ at: auditLog.createdAt, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'vehicle'),
        eq(auditLog.entityId, vehicleId),
        eq(auditLog.action, 'vehicle.unavailable'),
        sql`${auditLog.after} ->> 'date' = ${date}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.at === null) return null;
  const reason = (row.after as { reason?: unknown } | null)?.reason;
  return { at: row.at, reason: typeof reason === 'string' ? reason : null };
}

/** Loaders at the depot and the drivers of the changed vehicles see the plan change. */
async function notifyTrips(
  repo: PlanningRepo,
  db: PlanningDb,
  depotId: string,
  changed: readonly { id: string; vehicleId: string }[],
  now: Date,
): Promise<void> {
  if (changed.length === 0) return;
  const loaders = await repo.listUserIds(db, { role: 'loader', depotId });
  const drivers = await repo.listUserIds(db, {
    role: 'driver',
    vehicleIds: changed.map((trip) => trip.vehicleId),
  });
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const trip of changed) {
    for (const loader of loaders) {
      rows.push({
        recipientId: loader.id,
        type: 'plan_changed',
        priority: 'high',
        entityType: 'trip',
        entityId: trip.id,
        createdAt: now,
      });
    }
    for (const driver of drivers) {
      if (driver.vehicleId !== trip.vehicleId) continue;
      rows.push({
        recipientId: driver.id,
        type: 'plan_changed',
        priority: 'high',
        entityType: 'trip',
        entityId: trip.id,
        createdAt: now,
      });
    }
  }
  if (rows.length > 0) await db.insert(notifications).values(rows);
}

async function notifyStores(
  repo: PlanningRepo,
  db: PlanningDb,
  changes: readonly { orderId: string; type: 'plan_changed' | 'order_deferred' }[],
  orderById: ReadonlyMap<string, { outletId: string }>,
  now: Date,
): Promise<void> {
  const outletIds = [
    ...new Set(changes.flatMap((change) => orderById.get(change.orderId)?.outletId ?? [])),
  ];
  const managers = await repo.listStoreManagers(db, outletIds);
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const change of changes) {
    const outletId = orderById.get(change.orderId)?.outletId;
    for (const manager of managers) {
      if (manager.outletId !== outletId) continue;
      rows.push({
        recipientId: manager.id,
        type: change.type,
        priority: 'high',
        entityType: 'order',
        entityId: change.orderId,
        createdAt: now,
      });
    }
  }
  if (rows.length > 0) await db.insert(notifications).values(rows);
}

function planEvent(
  actorId: string,
  now: Date,
  depotId: string,
  serviceDate: string,
  runId: string,
): PlanningDomainEvent {
  return {
    type: 'allocation.changed',
    actorId,
    occurredAt: formatColomboTimestamp(now),
    depotId,
    serviceDate,
    runId,
  };
}
