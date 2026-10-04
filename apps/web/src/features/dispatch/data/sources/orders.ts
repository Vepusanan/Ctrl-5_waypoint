import {
  type AuditTimelineItem,
  auditTimelineSchema,
  deliveryStopSchema,
  issueListResponseSchema,
  type Order,
  orderListResponseSchema,
  orderSchema,
  outletListResponseSchema,
  type Role,
  tripListResponseSchema,
} from '@waypoint/shared';
import type { z } from 'zod';
import { api as http } from '../../../../lib/api';
import { orderName } from '../../../store/shared';
import type {
  AuditEvent,
  issueBoardSchema,
  LifecycleStep,
  orderAuditSchema,
  orderIndexSchema,
} from '../../contracts';
import type { Source } from '../client';

// D11 · Orders & audit, read from the orders list and the audit log (GET /audit).

const outletNames = async () => {
  const outlets = await http('/outlets', outletListResponseSchema);
  return new Map(outlets.items.map((outlet) => [outlet.id, `${outlet.brand} ${outlet.district}`]));
};

async function index(query: URLSearchParams): Promise<z.infer<typeof orderIndexSchema>> {
  const date = query.get('date') ?? '';
  const term = (query.get('q') ?? '').trim().toLowerCase();
  const vehicle = (query.get('vehicle') ?? '').trim();
  const [orders, names, trips] = await Promise.all([
    http(`/orders?requestedDate=${date}`, orderListResponseSchema),
    outletNames(),
    vehicle ? http(`/trips?date=${date}`, tripListResponseSchema) : null,
  ]);
  const onVehicle = trips
    ? new Set(
        trips.items
          .filter((trip) => trip.vehicleId === vehicle)
          .flatMap((trip) => trip.stops.map((stop) => stop.orderId)),
      )
    : null;
  const items = orders.items
    .filter((order) => order.status !== 'draft' && order.status !== 'cancelled')
    .filter((order) => onVehicle === null || onVehicle.has(order.id))
    .map((order) => ({
      id: order.id,
      reference: orderName(order.id),
      outletName: names.get(order.outletId) ?? order.brand,
      outletCode: order.outletId,
    }))
    .filter(
      (item) =>
        term === '' ||
        `${item.reference} ${item.outletName} ${item.outletCode}`.toLowerCase().includes(term),
    );
  return { items, total: items.length };
}

const step: Record<Order['status'], LifecycleStep> = {
  draft: 'submitted',
  submitted: 'submitted',
  confirmed: 'confirmed',
  deferred: 'confirmed',
  allocated: 'allocated',
  loading: 'loaded',
  dispatched: 'departed',
  failed: 'arrived',
  delivered: 'delivered',
  receipt_confirmed: 'received',
  cancelled: 'submitted',
};

const titles: Record<string, string> = {
  'order.created': 'Order placed',
  'order.submitted': 'Order submitted',
  'order.edited': 'Order edited',
  'order.cancelled': 'Order cancelled',
  'order.confirmed': 'Confirmed at cutoff',
  'order.deferred': 'Deferred',
  'plan.published': 'Plan published',
  'trip.resequenced': 'Stops resequenced',
  'loading.started': 'Loading started',
  'loading.verified': 'Load verified',
  'loading.issue_recorded': 'Loading shortfall reported',
  'loading.issue_acknowledged': 'Shortfall acknowledged',
  'loading.ready': 'Load ready',
  'trip.departed': 'Departed',
  'trip.completed': 'Trip completed',
  'stop.arrived': 'Arrived',
  'stop.pod_recorded': 'POD captured',
  'stop.delivered': 'Delivered',
  'stop.failed': 'Delivery failed',
  'issue.reported': 'Receipt issue reported',
  'issue.resolved': 'Receipt issue resolved',
  'plan.replanned': 'Plan changed after publish',
  'vehicle.unavailable': 'Vehicle marked unavailable',
  'receipt.confirmed': 'Receipt confirmed',
};

const people: Record<Role, { actor: string; actorRole: string; source: AuditEvent['source'] }> = {
  dispatcher: { actor: 'Dispatcher', actorRole: 'Planning', source: 'web' },
  loader: { actor: 'Loader', actorRole: 'Dock', source: 'tablet' },
  driver: { actor: 'Driver', actorRole: 'Driver', source: 'phone' },
  store_manager: { actor: 'Store manager', actorRole: 'Store', source: 'web' },
};

/** Where the API serves a stop's proof-of-delivery image. */
const podUrl = (stopId: string, kind: 'signature' | 'photo') =>
  `/api/v1/stops/${stopId}/pod/${kind}`;

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

// A stop event recorded without signal reaches the server later than it happened.
const OFFLINE_AFTER_MS = 60_000;

function event(item: AuditTimelineItem): AuditEvent {
  const who = people[item.role];
  const clientEventId = text(item.after?.clientEventId);
  const clientTime = text(item.after?.clientTime);
  const late =
    clientTime !== null && Date.parse(item.createdAt) - Date.parse(clientTime) > OFFLINE_AFTER_MS;
  return {
    id: item.id,
    at: clientTime ?? item.createdAt,
    title: titles[item.action] ?? item.action,
    actor: who.actor,
    actorRole: who.actorRole,
    source: late ? 'offline' : who.source,
    eventId: clientEventId ? `ev-${clientEventId.slice(0, 5)}` : `au-${item.id.slice(-5)}`,
    result: 'synced',
    syncedAt: late ? item.createdAt : null,
  };
}

async function audit(orderId: string): Promise<z.infer<typeof orderAuditSchema>> {
  const [order, names, timeline] = await Promise.all([
    http(`/orders/${orderId}`, orderSchema),
    outletNames(),
    http(`/audit?entityType=order&entityId=${orderId}`, auditTimelineSchema),
  ]);
  const stopId = timeline.items.find((item) => item.entityType === 'stop')?.entityId;
  const stop = stopId ? await http(`/stops/${stopId}`, deliveryStopSchema) : null;
  const podRow = timeline.items.find((item) => item.action === 'stop.pod_recorded');
  const receiptRow = timeline.items.find((item) => item.action === 'receipt.confirmed');
  const issue = timeline.items.find((item) => item.action === 'issue.reported');
  const podLate =
    stop?.pod && podRow
      ? Date.parse(podRow.createdAt) - Date.parse(stop.pod.clientTime) > OFFLINE_AFTER_MS
      : false;
  return {
    id: order.id,
    reference: orderName(order.id),
    outlet: { code: order.outletId, name: names.get(order.outletId) ?? order.brand },
    weightKg: order.weightKg,
    temp: order.temp,
    step: step[order.status],
    deferred: order.status === 'deferred',
    // Newest first, as the frame lists them.
    events: timeline.items.map(event).reverse(),
    pod: stop?.pod
      ? {
          recipient: stop.pod.recipientName,
          // Served from the one stored copy, and only to roles that may see this stop.
          photoUrl: stop.pod.hasPhoto ? podUrl(stop.id, 'photo') : null,
          signatureUrl: podUrl(stop.id, 'signature'),
          capturedAt: stop.pod.clientTime,
          capturedOffline: podLate,
          syncedAt: podLate && podRow ? podRow.createdAt : null,
        }
      : null,
    receipt: receiptRow
      ? {
          received: order.units,
          expected: order.units,
          unit: 'cartons',
          note: text(issue?.after?.note),
        }
      : null,
  };
}

// Store issues: the issue list joined with its order, outlet and delivery.
async function issueBoard(): Promise<z.infer<typeof issueBoardSchema>> {
  const [issues, orders, names, trips] = await Promise.all([
    http('/issues', issueListResponseSchema),
    http('/orders', orderListResponseSchema),
    outletNames(),
    http('/trips', tripListResponseSchema),
  ]);
  const orderById = new Map(orders.items.map((order) => [order.id, order]));
  const stops = trips.items.flatMap((trip) => trip.stops.map((stop) => ({ trip, stop })));
  const pods = new Map<string, Awaited<ReturnType<typeof stopOf>>>();
  const withStop = issues.items.flatMap((issue) => {
    const found = stops.find((item) => item.stop.orderId === issue.orderId);
    return found ? [found] : [];
  });
  await Promise.all(
    [...new Set(withStop.map((item) => item.stop.id))].map(async (id) => {
      pods.set(id, await stopOf(id));
    }),
  );
  const items = issues.items.map((issue) => {
    const order = orderById.get(issue.orderId);
    const found = stops.find((item) => item.stop.orderId === issue.orderId);
    const pod = found ? (pods.get(found.stop.id)?.pod ?? null) : null;
    return {
      id: issue.id,
      orderId: issue.orderId,
      reference: orderName(issue.orderId),
      outlet: {
        code: order?.outletId ?? 'Outlet',
        name: (order && names.get(order.outletId)) ?? order?.brand ?? 'Outlet',
      },
      type: issue.type,
      note: issue.note,
      status: issue.status,
      reportedAt: issue.createdAt,
      resolvedAt: issue.resolvedAt,
      resolution: issue.resolution,
      delivery: found
        ? {
            vehicleId: found.trip.vehicleId,
            tripNo: found.trip.tripNo,
            recipient: pod?.recipientName ?? null,
            signatureUrl: pod ? podUrl(found.stop.id, 'signature') : null,
            photoUrl: pod?.hasPhoto ? podUrl(found.stop.id, 'photo') : null,
          }
        : null,
    };
  });
  return { items, total: items.length };
}

/** A stop's delivery record, or null when it cannot be read. */
const stopOf = (stopId: string) => http(`/stops/${stopId}`, deliveryStopSchema).catch(() => null);

export const orderSources: readonly Source[] = [
  ['GET', '/issues/board', () => issueBoard()],
  ['GET', '/orders', ({ query }) => index(query)],
  ['GET', '/orders/:id/audit', ({ params }) => audit(params.id ?? '')],
];
