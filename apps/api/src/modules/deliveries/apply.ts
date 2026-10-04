import {
  IllegalTransitionError,
  notificationPriorityByType,
  orderStateMachine,
  type Pod,
  podUploadFieldsSchema,
  type StopEvent,
  type StopEventInput,
  type StopStatus,
  stopEventSchema,
  stopStateMachine,
  tripStateMachine,
  type User,
} from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DeliveryDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import { formatWindowClose, isArrivalLate } from './eta.ts';
import { imageKind, MAX_IMAGE_BYTES } from './images.ts';
import type { DeliveryDb, DeliveryRepo, DeliveryStopRow, PodRow, StopEventRow } from './repo.ts';

const MISSING = 'Stop not found';
const STALE_EVENT = 'This client event id was already recorded';
const CHANGED = 'Stop changed before the event was recorded';
const POD_REQUIRED = 'Delivery requires proof of delivery';
const POD_MISMATCH = 'Proof of delivery does not belong to this stop';
const POD_EXISTS = 'Proof of delivery is already recorded for this stop';
const POD_CLOSED = 'Proof of delivery cannot be recorded after the stop outcome';

// SYSTEM_DESIGN §8.6. Client clocks are trusted within reason.
export const STOP_EVENT_CLOCK_SKEW_MS = 12 * 60 * 60 * 1000;

export function stopEventClockSkewed(clientTime: Date, serverTime: Date): boolean {
  return Math.abs(clientTime.getTime() - serverTime.getTime()) > STOP_EVENT_CLOCK_SKEW_MS;
}

export interface PodUpload {
  recipientName: string;
  clientTime: string;
  signature: Buffer;
  photo?: Buffer;
}

export interface AppliedStopEvent {
  outcome: 'applied' | 'duplicate';
  event: StopEvent;
  domainEvents: DeliveryDomainEvent[];
}

export interface RecordedPod {
  pod: Pod;
  domainEvents: DeliveryDomainEvent[];
}

// Online routes and the sync module both call these functions.
// Delivery transitions stay here so the two paths cannot drift.
export async function applyStopEvent(
  db: DeliveryDb,
  repo: DeliveryRepo,
  audit: AuditRecorder,
  clock: OperatingClock,
  actor: User | null,
  stopId: string,
  input: StopEventInput,
): Promise<AppliedStopEvent> {
  const driver = assertDriver(actor);
  if (input.stopId !== stopId) {
    throw new ApiError('VALIDATION_ERROR', 'Stop id does not match the event');
  }
  const locked = await repo.lockStop(db, scope(driver).trips, stopId);
  if (locked === null) throw new ApiError('NOT_FOUND', MISSING);

  const existing = await repo.findEvent(db, input.clientEventId);
  if (existing !== null) {
    if (!sameRecordedStopEvent(existing, input)) {
      throw new ApiError('CONSTRAINT_VIOLATION', STALE_EVENT);
    }
    return { outcome: 'duplicate', event: toEvent(existing), domainEvents: [] };
  }
  if (locked.tripStatus !== 'departed') throw new ApiError('NOT_FOUND', MISSING);

  const serverTime = clock.now();
  const clientTime = new Date(input.clientTime);
  const inserted = await repo.insertEvent(db, {
    clientEventId: input.clientEventId,
    stopId,
    type: input.type,
    payload: input.payload,
    clientTime,
    serverTime,
    tripVersion: input.tripVersion,
  });
  if (inserted === null) {
    const raced = await repo.findEvent(db, input.clientEventId);
    if (raced !== null && sameRecordedStopEvent(raced, input)) {
      return { outcome: 'duplicate', event: toEvent(raced), domainEvents: [] };
    }
    throw new ApiError('CONSTRAINT_VIOLATION', STALE_EVENT);
  }

  const outcome = await applyOutcome(db, repo, locked, input, clientTime);
  const clockSkew = stopEventClockSkewed(clientTime, serverTime);
  const serverStamp = formatColomboTimestamp(serverTime);
  await notifyOutcome(db, repo, locked, input.type, serverTime);
  await audit.record(db, {
    actorId: driver.id,
    role: driver.role,
    action: `stop.${input.type}`,
    entityType: 'stop',
    entityId: locked.id,
    before: { status: locked.status, late: locked.late, orderStatus: locked.orderStatus },
    after: {
      status: outcome.status,
      late: outcome.late,
      orderStatus: outcome.orderStatus,
      stopId: locked.id,
      tripId: locked.tripId,
      orderId: locked.orderId,
      clientEventId: input.clientEventId,
      clientTime: input.clientTime,
      serverTime: serverStamp,
      clockSkew,
      tripVersion: input.tripVersion,
      eventId: inserted.id,
      ...outcome.extra,
    },
    createdAt: serverTime,
  });
  // The last outcome on a trip closes it (SYSTEM_DESIGN §5.3: Departed -> Completed).
  if (input.type !== 'arrived' && tripStateMachine.canTransition(locked.tripStatus, 'completed')) {
    const completed = await repo.completeTripIfDone(db, locked.tripId);
    if (completed) {
      await audit.record(db, {
        actorId: driver.id,
        role: driver.role,
        action: 'trip.completed',
        entityType: 'trip',
        entityId: locked.tripId,
        before: { status: locked.tripStatus },
        after: { status: 'completed', lastStopId: locked.id },
        createdAt: serverTime,
      });
    }
  }
  return {
    outcome: 'applied',
    event: toEvent(inserted),
    domainEvents: [deliveryEvent(input.type, driver.id, serverStamp, locked, outcome.late)],
  };
}

export async function recordPod(
  db: DeliveryDb,
  repo: DeliveryRepo,
  audit: AuditRecorder,
  clock: OperatingClock,
  actor: User | null,
  stopId: string,
  upload: PodUpload,
): Promise<RecordedPod> {
  const driver = assertDriver(actor);
  const fields = podUploadFieldsSchema.safeParse({
    recipientName: upload.recipientName,
    clientTime: upload.clientTime,
  });
  if (!fields.success) {
    const message = fields.error.issues[0]?.message ?? 'Invalid proof of delivery';
    throw new ApiError('VALIDATION_ERROR', message);
  }
  assertImage(upload.signature, 'Signature');
  if (upload.photo !== undefined) assertImage(upload.photo, 'Photo');

  const locked = await repo.lockStop(db, scope(driver).trips, stopId);
  if (locked === null || locked.tripStatus !== 'departed') {
    throw new ApiError('NOT_FOUND', MISSING);
  }
  if (locked.status !== 'pending' && locked.status !== 'arrived') {
    throw new ApiError('CONSTRAINT_VIOLATION', POD_CLOSED);
  }
  const existing = await repo.findPod(db, locked.id);
  if (existing !== null) throw new ApiError('CONSTRAINT_VIOLATION', POD_EXISTS);

  const clientTime = new Date(fields.data.clientTime);
  const saved = await repo.insertPod(db, {
    stopId: locked.id,
    recipientName: fields.data.recipientName,
    signature: upload.signature,
    clientTime,
    ...(upload.photo !== undefined ? { photo: upload.photo } : {}),
  });
  const now = clock.now();
  const pod = toPod(saved);
  await audit.record(db, {
    actorId: driver.id,
    role: driver.role,
    action: 'stop.pod_recorded',
    entityType: 'stop',
    entityId: locked.id,
    after: {
      podId: pod.id,
      recipientName: pod.recipientName,
      hasPhoto: pod.hasPhoto,
      clientTime: pod.clientTime,
    },
    createdAt: now,
  });
  return {
    pod,
    domainEvents: [
      deliveryEvent('pod_recorded', driver.id, formatColomboTimestamp(now), locked, locked.late),
    ],
  };
}

interface Outcome {
  status: StopStatus;
  late: boolean;
  orderStatus: DeliveryStopRow['orderStatus'];
  extra: Record<string, string>;
}

async function applyOutcome(
  db: DeliveryDb,
  repo: DeliveryRepo,
  locked: DeliveryStopRow,
  input: StopEventInput,
  clientTime: Date,
): Promise<Outcome> {
  switch (input.type) {
    case 'arrived':
      return arrive(db, repo, locked, clientTime);
    case 'delivered':
      return deliver(db, repo, locked, input.payload.podId);
    case 'failed':
      return fail(db, repo, locked, input.payload.reason);
  }
}

async function arrive(
  db: DeliveryDb,
  repo: DeliveryRepo,
  locked: DeliveryStopRow,
  clientTime: Date,
): Promise<Outcome> {
  assertMove(() => stopStateMachine.assertTransition(locked.status, 'arrived'));
  let late = false;
  try {
    late = isArrivalLate(clientTime, locked.serviceDate, locked.windowClose);
  } catch (error) {
    throw new ApiError(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Outlet window is invalid',
    );
  }
  if (!(await repo.markArrived(db, locked.id, late))) {
    throw new ApiError('CONSTRAINT_VIOLATION', CHANGED);
  }
  return { status: 'arrived', late, orderStatus: locked.orderStatus, extra: {} };
}

async function deliver(
  db: DeliveryDb,
  repo: DeliveryRepo,
  locked: DeliveryStopRow,
  podId: string,
): Promise<Outcome> {
  assertMove(() => stopStateMachine.assertTransition(locked.status, 'delivered'));
  assertMove(() => orderStateMachine.assertTransition(locked.orderStatus, 'delivered'));
  const pod = await repo.findPod(db, locked.id);
  if (pod === null) throw new ApiError('CONSTRAINT_VIOLATION', POD_REQUIRED);
  if (pod.id !== podId) throw new ApiError('CONSTRAINT_VIOLATION', POD_MISMATCH);
  if (!(await repo.markStop(db, locked.id, 'arrived', 'delivered'))) {
    throw new ApiError('CONSTRAINT_VIOLATION', CHANGED);
  }
  if (!(await repo.markOrder(db, locked.orderId, 'delivered'))) {
    throw new ApiError('CONSTRAINT_VIOLATION', CHANGED);
  }
  return {
    status: 'delivered',
    late: locked.late,
    orderStatus: 'delivered',
    extra: { podId },
  };
}

async function fail(
  db: DeliveryDb,
  repo: DeliveryRepo,
  locked: DeliveryStopRow,
  reason: string,
): Promise<Outcome> {
  assertMove(() => stopStateMachine.assertTransition(locked.status, 'failed'));
  assertMove(() => orderStateMachine.assertTransition(locked.orderStatus, 'failed'));
  if (!(await repo.markStop(db, locked.id, 'arrived', 'failed'))) {
    throw new ApiError('CONSTRAINT_VIOLATION', CHANGED);
  }
  if (!(await repo.markOrder(db, locked.orderId, 'failed'))) {
    throw new ApiError('CONSTRAINT_VIOLATION', CHANGED);
  }
  return { status: 'failed', late: locked.late, orderStatus: 'failed', extra: { reason } };
}

async function notifyOutcome(
  db: DeliveryDb,
  repo: DeliveryRepo,
  locked: DeliveryStopRow,
  type: StopEventInput['type'],
  now: Date,
): Promise<void> {
  if (type === 'arrived') return;
  const managers = await repo.listStoreManagers(db, locked.outletId);
  const notes = managers.map((manager) => ({
    recipientId: manager.id,
    type: type === 'delivered' ? ('delivered' as const) : ('delivery_failed' as const),
    priority: notificationPriorityByType[type === 'delivered' ? 'delivered' : 'delivery_failed'],
    entityType: 'stop' as const,
    entityId: locked.id,
    createdAt: now,
  }));
  if (type === 'failed') {
    const dispatchers = await repo.listDispatchers(db, locked.depotId);
    for (const dispatcher of dispatchers) {
      notes.push({
        recipientId: dispatcher.id,
        type: 'delivery_failed',
        priority: notificationPriorityByType.delivery_failed,
        entityType: 'stop',
        entityId: locked.id,
        createdAt: now,
      });
    }
  }
  await repo.insertNotifications(db, notes);
}

function deliveryEvent(
  type: 'arrived' | 'delivered' | 'failed' | 'pod_recorded',
  actorId: string,
  occurredAt: string,
  stop: DeliveryStopRow,
  late: boolean,
): DeliveryDomainEvent {
  const eventType =
    type === 'arrived'
      ? 'stop.arrived'
      : type === 'delivered'
        ? 'stop.delivered'
        : type === 'failed'
          ? 'stop.failed'
          : 'stop.pod_recorded';
  return {
    type: eventType,
    actorId,
    occurredAt,
    stopId: stop.id,
    tripId: stop.tripId,
    orderId: stop.orderId,
    outletId: stop.outletId,
    depotId: stop.depotId,
    late,
  };
}

function assertDriver(user: User | null): Extract<User, { role: 'driver' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'driver') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function assertMove(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      const entity = error.entity === 'stop' ? 'Stop' : 'Order';
      throw new ApiError(
        'CONSTRAINT_VIOLATION',
        `${entity} cannot move from ${error.from} to ${error.to}`,
      );
    }
    throw error;
  }
}

function assertImage(bytes: Buffer, label: string): void {
  if (bytes.length === 0) throw new ApiError('VALIDATION_ERROR', `${label} is required`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError('VALIDATION_ERROR', `${label} must not exceed 2 MB`);
  }
  if (imageKind(bytes) === null) {
    throw new ApiError('VALIDATION_ERROR', `${label} must be a PNG, JPEG, GIF, or WebP image`);
  }
}

export function sameRecordedStopEvent(row: StopEventRow, input: StopEventInput): boolean {
  return (
    row.stopId === input.stopId &&
    row.type === input.type &&
    row.tripVersion === input.tripVersion &&
    row.clientTime.getTime() === new Date(input.clientTime).getTime() &&
    JSON.stringify(row.payload) === JSON.stringify(input.payload)
  );
}

function toEvent(row: StopEventRow): StopEvent {
  return stopEventSchema.parse({
    id: row.id,
    clientEventId: row.clientEventId,
    stopId: row.stopId,
    type: row.type,
    payload: row.payload,
    clientTime: formatColomboTimestamp(row.clientTime),
    serverTime: formatColomboTimestamp(row.serverTime),
    tripVersion: row.tripVersion,
  });
}

function toPod(row: PodRow): Pod {
  return {
    id: row.id,
    stopId: row.stopId,
    recipientName: row.recipientName,
    hasPhoto: row.hasPhoto,
    clientTime: formatColomboTimestamp(row.clientTime),
  };
}

export function windowLabel(windowClose: string): string {
  try {
    return formatWindowClose(windowClose);
  } catch (error) {
    throw new ApiError(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Outlet window is invalid',
    );
  }
}
