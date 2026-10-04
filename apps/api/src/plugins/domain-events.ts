import fp from 'fastify-plugin';

// SYSTEM_DESIGN §11.2. Notifications subscribe later; modules only publish.
export interface OrderDomainEvent {
  type: 'order.submitted' | 'order.confirmed' | 'order.cancelled' | 'order.changed';
  orderId: string;
  outletId: string;
  actorId: string;
  occurredAt: string;
}

export interface PlanningDomainEvent {
  type: 'plan.published' | 'order.deferred' | 'allocation.changed';
  actorId: string;
  occurredAt: string;
  depotId: string;
  serviceDate: string;
  runId: string;
  orderId?: string;
  outletId?: string;
}

export interface TripDomainEvent {
  type: 'trip.changed' | 'trip.departed';
  actorId: string;
  occurredAt: string;
  tripId: string;
  vehicleId: string;
  depotId: string;
  version: number;
}

export interface LoadingDomainEvent {
  type:
    | 'loading.started'
    | 'loading.verified'
    | 'loading.issue_recorded'
    | 'loading.issue_acknowledged'
    | 'loading.ready';
  actorId: string;
  occurredAt: string;
  tripId: string;
  depotId: string;
  tripVersion: number;
  issueId?: string;
}

export interface DeliveryDomainEvent {
  type: 'stop.arrived' | 'stop.delivered' | 'stop.failed' | 'stop.pod_recorded';
  actorId: string;
  occurredAt: string;
  stopId: string;
  tripId: string;
  orderId: string;
  outletId: string;
  depotId: string;
  late: boolean;
}

interface ReceiptConfirmedEvent {
  type: 'receipt.confirmed';
  actorId: string;
  occurredAt: string;
  receiptId: string;
  stopId: string;
  orderId: string;
  outletId: string;
  depotId: string;
}

interface IssueReportedEvent {
  type: 'issue.reported' | 'issue.resolved';
  actorId: string;
  occurredAt: string;
  issueId: string;
  orderId: string;
  outletId: string;
  depotId: string;
  stopId: string | null;
}

export type StoreDomainEvent = ReceiptConfirmedEvent | IssueReportedEvent;

export interface SyncConflictDomainEvent {
  type: 'sync.conflict';
  actorId: string;
  occurredAt: string;
  conflictId: string;
  stopId: string;
  tripId: string;
  depotId: string;
}

export type DomainEvent =
  | OrderDomainEvent
  | PlanningDomainEvent
  | TripDomainEvent
  | LoadingDomainEvent
  | DeliveryDomainEvent
  | StoreDomainEvent
  | SyncConflictDomainEvent;

export interface DomainEventBus {
  publish(event: DomainEvent): void;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

function createDomainEventBus(): DomainEventBus {
  const listeners = new Set<(event: DomainEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const domainEventsPlugin = fp(
  async (app) => {
    app.decorate('domainEvents', createDomainEventBus());
  },
  { name: 'domain-events' },
);
