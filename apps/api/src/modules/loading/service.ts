import type { Database } from '@waypoint/database';
import type {
  CreateLoadingIssueRequest,
  LoadingIssue,
  LoadingState,
  LoadingStatus,
  SetLoadingCountRequest,
  User,
} from '@waypoint/shared';
import {
  loadingStateMachine,
  notificationPriorityByType,
  tripStateMachine,
} from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEventBus, LoadingDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import {
  createLoadingRepo,
  type LoadingBundle,
  type LoadingDb,
  type LoadingIssueRow,
  type LoadingRepo,
  type LockedTrip,
} from './repo.ts';

const MISSING = 'Trip not found';
const MISSING_ISSUE = 'Loading issue not found';
const STALE = 'Trip version is stale';
const PLAN_CHANGED = 'Loading plan changed. Verify the current plan before marking ready.';
const UNACKNOWLEDGED = 'Loading issues must be acknowledged before the load is ready';
const STARTED = 'Loading has already started';
const UNPUBLISHED = 'Trip has not been published';
const NOT_OPEN = 'Loading is not open for issues';
const NOT_VERIFIABLE = 'Loading can only be verified while it is in progress or has an exception';
const NOT_ON_TRIP = 'Order is not on this trip';
const NOT_COUNTABLE = 'Cartons can only be counted while loading is in progress';
const COUNT_OVER = 'The count cannot exceed the cartons on the order';
const QTY = 'Issue quantity exceeds the order';
const ORDER = 'Order is not ready to load';
const ALREADY_ACK = 'Loading issue is already acknowledged';
const UNVERIFIED = 'Verify the load against the plan before marking it ready';
const TRIP_READY = 'Trip cannot be marked ready';
const LOADING_READY = 'Loading cannot be marked ready';

const OPEN: readonly LoadingStatus[] = ['in_progress', 'exception'];

export interface LoadingService {
  get(user: User | null, tripId: string): Promise<LoadingState>;
  start(user: User | null, tripId: string, version: number): Promise<LoadingState>;
  verify(user: User | null, tripId: string, version: number): Promise<LoadingState>;
  recordIssue(
    user: User | null,
    tripId: string,
    version: number,
    input: CreateLoadingIssueRequest,
  ): Promise<LoadingState>;
  setCount(user: User | null, tripId: string, input: SetLoadingCountRequest): Promise<LoadingState>;
  acknowledge(user: User | null, issueId: string): Promise<LoadingIssue>;
  ready(user: User | null, tripId: string, version: number): Promise<LoadingState>;
}

export function createLoadingService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: LoadingRepo = createLoadingRepo(),
): LoadingService {
  return {
    async get(user, tripId) {
      const reader = assertReader(user);
      const bundle = await repo.load(db, scope(reader).trips, tripId);
      if (bundle === null) throw new ApiError('NOT_FOUND', MISSING);
      return toState(bundle);
    },

    async start(user, tripId, version) {
      const loader = assertLoader(user);
      const pending: LoadingDomainEvent[] = [];
      const state = await db.transaction(async (tx) => {
        const trip = await lockedTrip(repo, tx, loader, tripId);
        if (trip.version !== version) throw new ApiError('VERSION_CONFLICT', STALE);
        if (trip.runStatus !== 'published' || trip.status !== 'published') {
          throw new ApiError('CONSTRAINT_VIOLATION', UNPUBLISHED);
        }
        if (!tripStateMachine.canTransition(trip.status, 'loading')) {
          throw new ApiError('CONSTRAINT_VIOLATION', UNPUBLISHED);
        }
        const existing = await repo.lockLoading(tx, trip.id);
        if (existing !== null) throw new ApiError('CONSTRAINT_VIOLATION', STARTED);
        const current = await requiredBundle(repo, tx, loader, trip.id);
        const orderIds = current.stops.map((stop) => stop.orderId);
        const lockedOrders = await repo.lockOrders(tx, orderIds);
        if (lockedOrders.length !== orderIds.length) {
          throw new ApiError('CONSTRAINT_VIOLATION', ORDER);
        }
        for (const order of lockedOrders) {
          if (order.status !== 'allocated') throw new ApiError('CONSTRAINT_VIOLATION', ORDER);
        }
        await repo.insertLoading(tx, trip.id, loader.id, trip.version);
        const moved = await repo.setTripStatus(tx, trip.id, 'published', 'loading', version);
        if (!moved) throw new ApiError('VERSION_CONFLICT', STALE);
        for (const orderId of orderIds) {
          const marked = await repo.markOrderLoading(tx, orderId);
          if (!marked) throw new ApiError('VERSION_CONFLICT', 'Order changed during loading');
        }
        const now = clock.now();
        await audit.record(tx, {
          actorId: loader.id,
          role: loader.role,
          action: 'loading.started',
          entityType: 'trip',
          entityId: trip.id,
          before: { tripStatus: 'published', loadingStatus: 'not_started', tripVersion: version },
          after: {
            tripStatus: 'loading',
            loadingStatus: 'in_progress',
            tripVersion: version,
            loaderId: loader.id,
            acceptedPlan: planSnapshot(current),
          },
          createdAt: now,
        });
        pending.push(loadingEvent('loading.started', loader.id, now, trip));
        return toState(await requiredBundle(repo, tx, loader, trip.id));
      });
      publish(events, pending);
      return state;
    },

    async verify(user, tripId, version) {
      const loader = assertLoader(user);
      const pending: LoadingDomainEvent[] = [];
      const state = await db.transaction(async (tx) => {
        const trip = await lockedTrip(repo, tx, loader, tripId);
        if (trip.version !== version) throw new ApiError('VERSION_CONFLICT', STALE);
        const loading = await repo.lockLoading(tx, trip.id);
        if (loading === null || !OPEN.includes(loading.status)) {
          throw new ApiError('CONSTRAINT_VIOLATION', NOT_VERIFIABLE);
        }
        const now = clock.now();
        const accepted = await repo.acceptPlan(tx, trip.id, trip.version, now);
        if (!accepted) throw new ApiError('CONSTRAINT_VIOLATION', NOT_VERIFIABLE);
        const current = await requiredBundle(repo, tx, loader, trip.id);
        await audit.record(tx, {
          actorId: loader.id,
          role: loader.role,
          action: 'loading.verified',
          entityType: 'trip',
          entityId: trip.id,
          before: {
            acceptedTripVersion: loading.acceptedTripVersion,
            verifiedAt:
              loading.verifiedAt === null ? null : formatColomboTimestamp(loading.verifiedAt),
          },
          after: {
            acceptedPlan: planSnapshot(current),
            acceptedTripVersion: trip.version,
            planVersion: trip.planVersion,
            verifiedAt: formatColomboTimestamp(now),
            stops: current.stops.map((stop) => ({
              seq: stop.seq,
              orderId: stop.orderId,
              units: stop.units,
              loadedUnits: stop.loadedUnits,
              temp: stop.temp,
            })),
          },
          createdAt: now,
        });
        pending.push(loadingEvent('loading.verified', loader.id, now, trip));
        return { ...toState(current), acceptedPlan: planSnapshot(current) };
      });
      publish(events, pending);
      return state;
    },

    async recordIssue(user, tripId, version, input) {
      const loader = assertLoader(user);
      const pending: LoadingDomainEvent[] = [];
      const state = await db.transaction(async (tx) => {
        const trip = await lockedTrip(repo, tx, loader, tripId);
        if (trip.version !== version) throw new ApiError('VERSION_CONFLICT', STALE);
        const loading = await repo.lockLoading(tx, trip.id);
        if (loading === null || !OPEN.includes(loading.status)) {
          throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
        }
        const order = await repo.orderOnTrip(tx, trip.id, input.orderId);
        if (order === null) throw new ApiError('CONSTRAINT_VIOLATION', NOT_ON_TRIP);
        if (input.qty > order.units) throw new ApiError('CONSTRAINT_VIOLATION', QTY);
        const now = clock.now();
        const issue = await repo.insertIssue(tx, {
          tripId: trip.id,
          orderId: input.orderId,
          type: input.type,
          qty: input.qty,
          note: input.note ?? null,
          loaderId: loader.id,
          createdAt: now,
        });
        if (loading.status === 'in_progress') {
          if (!loadingStateMachine.canTransition('in_progress', 'exception')) {
            throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
          }
          const moved = await repo.setLoadingStatus(tx, trip.id, 'in_progress', 'exception');
          if (!moved) throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
        }
        const dispatchers = await repo.listDispatchers(tx, trip.depotId);
        await repo.insertNotifications(
          tx,
          dispatchers.map((dispatcher) => ({
            recipientId: dispatcher.id,
            type: 'loading_shortfall',
            priority: notificationPriorityByType.loading_shortfall,
            entityType: 'loading_issue',
            entityId: issue.id,
            createdAt: now,
          })),
        );
        await audit.record(tx, {
          actorId: loader.id,
          role: loader.role,
          action: 'loading.issue_recorded',
          entityType: 'loading_issue',
          entityId: issue.id,
          after: {
            tripId: issue.tripId,
            orderId: issue.orderId,
            type: issue.type,
            qty: issue.qty,
            note: issue.note,
            loaderId: issue.loaderId,
            createdAt: formatColomboTimestamp(issue.createdAt),
            loadingStatus: loading.status === 'in_progress' ? 'exception' : loading.status,
          },
          createdAt: now,
        });
        pending.push(loadingEvent('loading.issue_recorded', loader.id, now, trip, issue.id));
        return toState(await requiredBundle(repo, tx, loader, trip.id));
      });
      publish(events, pending);
      return state;
    },

    // The count is the loader's working tally, saved so a refresh or another tablet shows it.
    // It is not versioned: a plan change is caught at verify, which is what gates Ready.
    async setCount(user, tripId, input) {
      const loader = assertLoader(user);
      return db.transaction(async (tx) => {
        const trip = await lockedTrip(repo, tx, loader, tripId);
        const loading = await repo.lockLoading(tx, trip.id);
        if (loading === null || !OPEN.includes(loading.status)) {
          throw new ApiError('CONSTRAINT_VIOLATION', NOT_COUNTABLE);
        }
        const order = await repo.orderOnTrip(tx, trip.id, input.orderId);
        if (order === null) throw new ApiError('CONSTRAINT_VIOLATION', NOT_ON_TRIP);
        if (input.units > order.units) throw new ApiError('CONSTRAINT_VIOLATION', COUNT_OVER);
        await repo.saveCount(tx, {
          tripId: trip.id,
          orderId: input.orderId,
          units: input.units,
          loaderId: loader.id,
          at: clock.now(),
        });
        return toState(await requiredBundle(repo, tx, loader, trip.id));
      });
    },

    async acknowledge(user, issueId) {
      const dispatcher = assertDispatcher(user);
      const pending: LoadingDomainEvent[] = [];
      const issue = await db.transaction(async (tx) => {
        const located = await repo.locateIssue(tx, scope(dispatcher).trips, issueId);
        if (located === null) throw new ApiError('NOT_FOUND', MISSING_ISSUE);
        const trip = await lockedTrip(repo, tx, dispatcher, located.tripId);
        const current = await repo.lockIssue(tx, issueId);
        if (current === null) throw new ApiError('NOT_FOUND', MISSING_ISSUE);
        if (current.acknowledgedBy !== null)
          throw new ApiError('CONSTRAINT_VIOLATION', ALREADY_ACK);
        const loading = await repo.lockLoading(tx, trip.id);
        if (loading === null) throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
        const now = clock.now();
        const saved = await repo.acknowledgeIssue(tx, issueId, dispatcher.id, now);
        if (saved === null) throw new ApiError('CONSTRAINT_VIOLATION', ALREADY_ACK);
        const open = await repo.countOpenIssues(tx, trip.id);
        let loadingStatus = loading.status;
        if (open === 0 && loading.status === 'exception') {
          if (!loadingStateMachine.canTransition('exception', 'in_progress')) {
            throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
          }
          const moved = await repo.setLoadingStatus(tx, trip.id, 'exception', 'in_progress');
          if (!moved) throw new ApiError('CONSTRAINT_VIOLATION', NOT_OPEN);
          loadingStatus = 'in_progress';
        }
        await audit.record(tx, {
          actorId: dispatcher.id,
          role: dispatcher.role,
          action: 'loading.issue_acknowledged',
          entityType: 'loading_issue',
          entityId: saved.id,
          before: { acknowledgedBy: null, acknowledgedAt: null, loadingStatus: loading.status },
          after: {
            acknowledgedBy: dispatcher.id,
            acknowledgedAt: formatColomboTimestamp(now),
            loadingStatus,
          },
          createdAt: now,
        });
        pending.push(
          loadingEvent('loading.issue_acknowledged', dispatcher.id, now, trip, saved.id),
        );
        return toIssue(saved);
      });
      publish(events, pending);
      return issue;
    },

    async ready(user, tripId, version) {
      const loader = assertLoader(user);
      const pending: LoadingDomainEvent[] = [];
      const state = await db.transaction(async (tx) => {
        const trip = await lockedTrip(repo, tx, loader, tripId);
        if (trip.version !== version) throw new ApiError('VERSION_CONFLICT', STALE);
        if (trip.runStatus !== 'published') throw new ApiError('CONSTRAINT_VIOLATION', UNPUBLISHED);
        const loading = await repo.lockLoading(tx, trip.id);
        if (loading === null) throw new ApiError('CONSTRAINT_VIOLATION', LOADING_READY);
        // A resequence keeps the new If-Match from marking Ready on the old list.
        if (loading.acceptedTripVersion !== trip.version) {
          throw new ApiError('VERSION_CONFLICT', PLAN_CHANGED);
        }
        const open = await repo.countOpenIssues(tx, trip.id);
        if (open > 0) throw new ApiError('CONSTRAINT_VIOLATION', UNACKNOWLEDGED);
        // SRS §19: Ready only once the load has been checked against the plan.
        if (loading.verifiedAt === null) throw new ApiError('CONSTRAINT_VIOLATION', UNVERIFIED);
        if (!tripStateMachine.canTransition(trip.status, 'ready')) {
          throw new ApiError('CONSTRAINT_VIOLATION', TRIP_READY);
        }
        if (!loadingStateMachine.canTransition(loading.status, 'ready')) {
          throw new ApiError('CONSTRAINT_VIOLATION', LOADING_READY);
        }
        const loadingMoved = await repo.setLoadingStatus(tx, trip.id, loading.status, 'ready');
        if (!loadingMoved) throw new ApiError('CONSTRAINT_VIOLATION', LOADING_READY);
        const tripMoved = await repo.setTripStatus(tx, trip.id, trip.status, 'ready', version);
        if (!tripMoved) throw new ApiError('VERSION_CONFLICT', STALE);
        const now = clock.now();
        await audit.record(tx, {
          actorId: loader.id,
          role: loader.role,
          action: 'loading.ready',
          entityType: 'trip',
          entityId: trip.id,
          before: {
            tripStatus: trip.status,
            loadingStatus: loading.status,
            tripVersion: trip.version,
          },
          after: { tripStatus: 'ready', loadingStatus: 'ready', tripVersion: trip.version },
          createdAt: now,
        });
        pending.push(loadingEvent('loading.ready', loader.id, now, trip));
        return toState(await requiredBundle(repo, tx, loader, trip.id));
      });
      publish(events, pending);
      return state;
    },
  };
}

function assertReader(user: User | null): User {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role === 'store_manager') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function assertLoader(user: User | null): Extract<User, { role: 'loader' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'loader') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function assertDispatcher(user: User | null): Extract<User, { role: 'dispatcher' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

async function lockedTrip(
  repo: LoadingRepo,
  db: LoadingDb,
  user: User,
  tripId: string,
): Promise<LockedTrip> {
  const trip = await repo.lockTrip(db, scope(user).trips, tripId);
  if (trip === null) throw new ApiError('NOT_FOUND', MISSING);
  return trip;
}

async function requiredBundle(
  repo: LoadingRepo,
  db: LoadingDb,
  user: User,
  tripId: string,
): Promise<LoadingBundle> {
  const bundle = await repo.load(db, scope(user).trips, tripId);
  if (bundle === null) throw new ApiError('INTERNAL_ERROR', 'Trip disappeared during loading');
  return bundle;
}

function toIssue(issue: LoadingIssueRow): LoadingIssue {
  return {
    id: issue.id,
    tripId: issue.tripId,
    orderId: issue.orderId,
    type: issue.type,
    qty: issue.qty,
    note: issue.note,
    loaderId: issue.loaderId,
    acknowledgedBy: issue.acknowledgedBy,
    acknowledgedAt:
      issue.acknowledgedAt === null ? null : formatColomboTimestamp(issue.acknowledgedAt),
    createdAt: formatColomboTimestamp(issue.createdAt),
  };
}

function toState(bundle: LoadingBundle): LoadingState {
  const record = bundle.record;
  return {
    acceptedPlan: bundle.acceptedPlan ?? null,
    tripId: bundle.trip.id,
    status: record?.status ?? 'not_started',
    loaderId: record?.loaderId ?? null,
    tripVersion: bundle.trip.version,
    planVersion: bundle.trip.planVersion,
    acceptedTripVersion: record?.acceptedTripVersion ?? null,
    planStale: record !== null && record.acceptedTripVersion !== bundle.trip.version,
    verifiedAt:
      record === null || record.verifiedAt === null
        ? null
        : formatColomboTimestamp(record.verifiedAt),
    vehicle: bundle.vehicle,
    // Sequence stays canonical. Reverse-stop display belongs to the loader screen.
    stops: bundle.stops.map((stop) => ({
      id: stop.id,
      seq: stop.seq,
      plannedArrival: formatColomboTimestamp(stop.plannedArrival),
      order: {
        id: stop.orderId,
        outletId: stop.outletId,
        brand: stop.brand,
        temp: stop.temp,
        requestedDate: stop.requestedDate,
        units: stop.units,
        weightKg: stop.weightKg,
        volumeM3: stop.volumeM3,
        status: stop.orderStatus,
      },
      loadedUnits: stop.loadedUnits,
      chilled: stop.temp === 'chilled',
      access: stop.parkingConstraint,
    })),
    issues: bundle.issues.map(toIssue),
  };
}

function loadingEvent(
  type: LoadingDomainEvent['type'],
  actorId: string,
  now: Date,
  trip: LockedTrip,
  issueId?: string,
): LoadingDomainEvent {
  return {
    type,
    actorId,
    occurredAt: formatColomboTimestamp(now),
    tripId: trip.id,
    depotId: trip.depotId,
    tripVersion: trip.version,
    ...(issueId !== undefined ? { issueId } : {}),
  };
}

function publish(events: DomainEventBus, pending: readonly LoadingDomainEvent[]): void {
  for (const event of pending) events.publish(event);
}

function planSnapshot(bundle: LoadingBundle) {
  const state = toState(bundle);
  return { planVersion: state.planVersion, tripVersion: state.tripVersion, stops: state.stops };
}
