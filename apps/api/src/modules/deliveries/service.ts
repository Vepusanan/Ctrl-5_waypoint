import { type Database, eq, orders } from '@waypoint/database';
import type { DeliveryStop, Pod, StopEventInput, User } from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEventBus } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import {
  type AppliedStopEvent,
  applyStopEvent,
  type PodUpload,
  recordPod,
  windowLabel,
} from './apply.ts';
import { shiftedEta } from './eta.ts';
import { imageKind } from './images.ts';
import {
  createDeliveryRepo,
  type DeliveryRepo,
  type DeliveryStopRow,
  type PodRow,
} from './repo.ts';

const MISSING = 'Stop not found';
const NO_IMAGE = 'No image is stored for this stop';

export interface DeliveryService {
  get(user: User | null, stopId: string): Promise<DeliveryStop>;
  recordEvent(user: User | null, stopId: string, input: StopEventInput): Promise<AppliedStopEvent>;
  recordPod(user: User | null, stopId: string, upload: PodUpload): Promise<Pod>;
  podImage(
    user: User | null,
    stopId: string,
    kind: 'signature' | 'photo',
  ): Promise<{ bytes: Buffer; contentType: string }>;
}

export function createDeliveryService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: DeliveryRepo = createDeliveryRepo(),
): DeliveryService {
  return {
    async get(user, stopId) {
      const reader = assertReader(user);
      const row = await repo.findStop(db, scope(reader).trips, stopId, reader.role === 'driver');
      if (row === null) throw new ApiError('NOT_FOUND', MISSING);
      const [stops, arrivals, pod, failureReason] = await Promise.all([
        repo.listStops(db, row.tripId),
        repo.listArrivals(db, row.tripId),
        repo.findPod(db, row.id),
        row.status === 'failed' ? repo.failureReason(db, row.id) : Promise.resolve(null),
      ]);
      const eta = shiftedEta(stops, arrivals, row.id);
      if (eta === null) throw new ApiError('INTERNAL_ERROR', 'Stop is missing from its trip');
      return toStop(row, eta, pod, failureReason);
    },

    // SRS §40: proof of delivery is protected from cross-role and cross-outlet access. The
    // dispatcher sees their depot's stops, the driver their own vehicle's, and the store manager
    // only stops that delivered to their outlet. The image is served from the one stored copy.
    async podImage(user, stopId, kind) {
      if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
      if (user.role === 'loader') {
        throw new ApiError('FORBIDDEN', 'You do not have access to this action');
      }
      const access =
        user.role === 'store_manager' ? eq(orders.outletId, user.outletId) : scope(user).trips;
      const result = await repo.findPodImage(db, access, stopId, kind);
      if (!result.found || result.image === null) throw new ApiError('NOT_FOUND', NO_IMAGE);
      const format = imageKind(result.image);
      if (format === null) throw new ApiError('NOT_FOUND', NO_IMAGE);
      return { bytes: result.image, contentType: `image/${format}` };
    },

    async recordEvent(user, stopId, input) {
      const result = await db.transaction((tx) =>
        applyStopEvent(tx, repo, audit, clock, user, stopId, input),
      );
      publish(events, result.domainEvents);
      return result;
    },

    async recordPod(user, stopId, upload) {
      const result = await db.transaction((tx) =>
        recordPod(tx, repo, audit, clock, user, stopId, upload),
      );
      publish(events, result.domainEvents);
      return result.pod;
    },
  };
}

function assertReader(user: User | null): Extract<User, { role: 'dispatcher' | 'driver' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher' && user.role !== 'driver') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function toStop(
  row: DeliveryStopRow,
  eta: Date,
  pod: PodRow | null,
  failureReason: string | null,
): DeliveryStop {
  return {
    id: row.id,
    tripId: row.tripId,
    tripStatus: row.tripStatus,
    tripVersion: row.tripVersion,
    seq: row.seq,
    plannedArrival: formatColomboTimestamp(row.plannedArrival),
    eta: formatColomboTimestamp(eta),
    status: row.status,
    late: row.late,
    windowClose: windowLabel(row.windowClose),
    failureReason,
    order: {
      id: row.orderId,
      outletId: row.outletId,
      brand: row.brand,
      temp: row.temp,
      requestedDate: row.requestedDate,
      units: row.units,
      weightKg: row.weightKg,
      volumeM3: row.volumeM3,
      status: row.orderStatus,
    },
    pod:
      pod === null
        ? null
        : {
            id: pod.id,
            stopId: pod.stopId,
            recipientName: pod.recipientName,
            hasPhoto: pod.hasPhoto,
            clientTime: formatColomboTimestamp(pod.clientTime),
          },
  };
}

function publish(events: DomainEventBus, pending: AppliedStopEvent['domainEvents']): void {
  for (const event of pending) events.publish(event);
}
