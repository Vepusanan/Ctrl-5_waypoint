import {
  DASHBOARD_POLL_INTERVAL_MS,
  type DashboardStreamEntityType,
  type DashboardStreamEventType,
  type DashboardStreamMessage,
} from '@waypoint/shared';
import type { DomainEvent, OrderDomainEvent } from '../../plugins/domain-events.ts';

export function streamPreamble(): string {
  const ready = { type: 'ready', pollIntervalMs: DASHBOARD_POLL_INTERVAL_MS };
  return `retry: ${DASHBOARD_POLL_INTERVAL_MS}\n\nevent: ready\ndata: ${JSON.stringify(ready)}\n\n`;
}

export function streamEventFrame(message: DashboardStreamMessage): string {
  return `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}

/** Depot dispatchers only hear their depot. A central dispatcher has no depot and hears every event. */
export function dashboardEventVisible(
  depotId: string | null,
  outletIds: ReadonlySet<string> | null,
  event: DomainEvent,
): boolean {
  if (depotId === null) return true;
  if (isOrderEvent(event)) return outletIds?.has(event.outletId) ?? false;
  return event.depotId === depotId;
}

export function toDashboardStreamMessage(event: DomainEvent): DashboardStreamMessage {
  switch (event.type) {
    case 'order.submitted':
    case 'order.confirmed':
    case 'order.cancelled':
    case 'order.changed':
      return message(event.type, event.occurredAt, 'order', event.orderId);
    case 'plan.published':
      return message(event.type, event.occurredAt, 'planning_run', event.runId);
    case 'order.deferred':
    case 'allocation.changed':
      return message(
        event.type,
        event.occurredAt,
        event.orderId === undefined ? 'planning_run' : 'order',
        event.orderId ?? event.runId,
      );
    case 'trip.changed':
    case 'trip.departed':
      return message(event.type, event.occurredAt, 'trip', event.tripId);
    case 'loading.started':
    case 'loading.verified':
    case 'loading.issue_acknowledged':
    case 'loading.ready':
      return message(event.type, event.occurredAt, 'trip', event.tripId);
    case 'loading.issue_recorded':
      return message(
        event.type,
        event.occurredAt,
        event.issueId === undefined ? 'trip' : 'loading_issue',
        event.issueId ?? event.tripId,
      );
    case 'stop.arrived':
    case 'stop.delivered':
    case 'stop.failed':
    case 'stop.pod_recorded':
      return message(event.type, event.occurredAt, 'stop', event.stopId);
    case 'receipt.confirmed':
      return message(event.type, event.occurredAt, 'receipt', event.receiptId);
    case 'issue.reported':
    case 'issue.resolved':
      return message(event.type, event.occurredAt, 'issue', event.issueId);
    case 'sync.conflict':
      return message(event.type, event.occurredAt, 'sync_conflict', event.conflictId);
    default:
      return assertNever(event);
  }
}

function message(
  type: DashboardStreamEventType,
  occurredAt: string,
  entityType: DashboardStreamEntityType,
  entityId: string,
): DashboardStreamMessage {
  return { type, occurredAt, entityType, entityId };
}

function isOrderEvent(event: DomainEvent): event is OrderDomainEvent {
  return (
    event.type === 'order.submitted' ||
    event.type === 'order.confirmed' ||
    event.type === 'order.cancelled' ||
    event.type === 'order.changed'
  );
}

function assertNever(event: never): never {
  const type = (event as { type?: string }).type ?? 'unknown';
  throw new Error(`Unhandled domain event ${type}`);
}
