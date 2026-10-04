import type { Database } from '@waypoint/database';
import type { CreateIssueRequest, Issue, IssueListResponse, Receipt, User } from '@waypoint/shared';
import { notificationPriorityByType, orderStateMachine } from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEventBus, StoreDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import { createReceiptRepo, type IssueRow, type ReceiptRepo, type ReceiptRow } from './repo.ts';

const MISSING_STOP = 'Stop not found';
const MISSING_ORDER = 'Order not found';
const MISSING_ISSUE = 'Issue not found';
const ISSUE_BEFORE_DELIVERY = 'An issue can only be reported for a delivered order';
const NOT_DELIVERED = 'Only a delivered stop can be receipt-confirmed';

interface ConfirmedReceipt {
  receipt: Receipt;
  created: boolean;
}

export interface ReceiptService {
  confirm(user: User | null, stopId: string): Promise<ConfirmedReceipt>;
  createIssue(user: User | null, input: CreateIssueRequest): Promise<Issue>;
  listIssues(user: User | null): Promise<IssueListResponse>;
  getIssue(user: User | null, issueId: string): Promise<Issue>;
}

export function createReceiptService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: ReceiptRepo = createReceiptRepo(),
): ReceiptService {
  return {
    async confirm(user, stopId) {
      const manager = assertStoreManager(user);
      const pending: StoreDomainEvent[] = [];
      const result = await db.transaction(async (tx) => {
        const locked = await repo.lockStop(tx, scope(manager).orders, stopId);
        if (locked === null) throw new ApiError('NOT_FOUND', MISSING_STOP);
        const existing = await repo.findReceipt(tx, locked.id);
        if (existing !== null) {
          return { receipt: toReceipt(existing), created: false };
        }
        if (
          locked.stopStatus !== 'delivered' ||
          !orderStateMachine.canTransition(locked.orderStatus, 'receipt_confirmed')
        ) {
          throw new ApiError('CONSTRAINT_VIOLATION', NOT_DELIVERED);
        }
        const now = clock.now();
        const saved = await repo.insertReceipt(tx, {
          stopId: locked.id,
          confirmedBy: manager.id,
          confirmedAt: now,
        });
        if (saved === null) {
          const raced = await repo.findReceipt(tx, locked.id);
          if (raced === null) throw new ApiError('INTERNAL_ERROR', 'Receipt was not stored');
          return { receipt: toReceipt(raced), created: false };
        }
        const moved = await repo.confirmOrder(tx, locked.orderId);
        if (!moved) throw new ApiError('CONSTRAINT_VIOLATION', NOT_DELIVERED);
        const confirmedAt = formatColomboTimestamp(now);
        await audit.record(tx, {
          actorId: manager.id,
          role: manager.role,
          action: 'receipt.confirmed',
          entityType: 'order',
          entityId: locked.orderId,
          before: { status: 'delivered', stopStatus: 'delivered' },
          after: {
            status: 'receipt_confirmed',
            stopId: locked.id,
            receiptId: saved.id,
            confirmedBy: manager.id,
            confirmedAt,
          },
          createdAt: now,
        });
        pending.push({
          type: 'receipt.confirmed',
          actorId: manager.id,
          occurredAt: confirmedAt,
          receiptId: saved.id,
          stopId: locked.id,
          orderId: locked.orderId,
          outletId: locked.outletId,
          depotId: locked.depotId,
        });
        return { receipt: toReceipt(saved), created: true };
      });
      publish(events, pending);
      return result;
    },

    async createIssue(user, input) {
      const manager = assertStoreManager(user);
      const pending: StoreDomainEvent[] = [];
      const issue = await db.transaction(async (tx) => {
        const order = await repo.lockOrder(tx, scope(manager).orders, input.orderId);
        if (order === null) throw new ApiError('NOT_FOUND', MISSING_ORDER);
        // SRS §28: a discrepancy is about goods that arrived, so it needs a delivery.
        if (order.status !== 'delivered' && order.status !== 'receipt_confirmed') {
          throw new ApiError('CONSTRAINT_VIOLATION', ISSUE_BEFORE_DELIVERY);
        }
        const stopId = await repo.findStopId(tx, order.id);
        const now = clock.now();
        const saved = await repo.insertIssue(tx, {
          orderId: order.id,
          type: input.type,
          note: input.note ?? null,
          createdBy: manager.id,
          createdAt: now,
        });
        const dispatchers = await repo.listDispatchers(tx, order.depotId);
        await repo.insertNotifications(
          tx,
          dispatchers.map((dispatcher) => ({
            recipientId: dispatcher.id,
            type: 'receipt_discrepancy',
            priority: notificationPriorityByType.receipt_discrepancy,
            entityType: 'issue',
            entityId: saved.id,
            createdAt: now,
          })),
        );
        const createdAt = formatColomboTimestamp(saved.createdAt);
        await audit.record(tx, {
          actorId: manager.id,
          role: manager.role,
          action: 'issue.reported',
          entityType: 'issue',
          entityId: saved.id,
          after: {
            orderId: saved.orderId,
            stopId,
            type: saved.type,
            note: saved.note,
            status: saved.status,
            createdBy: saved.createdBy,
            createdAt,
          },
          createdAt: now,
        });
        pending.push({
          type: 'issue.reported',
          actorId: manager.id,
          occurredAt: createdAt,
          issueId: saved.id,
          orderId: saved.orderId,
          outletId: order.outletId,
          depotId: order.depotId,
          stopId,
        });
        return toIssue(saved);
      });
      publish(events, pending);
      return issue;
    },

    async listIssues(user) {
      const reader = assertReader(user);
      const rows = await repo.listIssues(db, scope(reader).orders);
      const items = rows.map(toIssue);
      return { items, total: items.length };
    },

    async getIssue(user, issueId) {
      const reader = assertReader(user);
      const row = await repo.findIssue(db, scope(reader).orders, issueId);
      if (row === null) throw new ApiError('NOT_FOUND', MISSING_ISSUE);
      return toIssue(row);
    },
  };
}

function assertStoreManager(user: User | null): Extract<User, { role: 'store_manager' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'store_manager') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function assertReader(user: User | null): Extract<User, { role: 'dispatcher' | 'store_manager' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher' && user.role !== 'store_manager') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    stopId: row.stopId,
    confirmedBy: row.confirmedBy,
    confirmedAt: formatColomboTimestamp(row.confirmedAt),
  };
}

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    orderId: row.orderId,
    type: row.type,
    note: row.note,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: formatColomboTimestamp(row.createdAt),
  };
}

function publish(events: DomainEventBus, pending: readonly StoreDomainEvent[]): void {
  for (const event of pending) events.publish(event);
}
