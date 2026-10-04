import type { Database } from '@waypoint/database';
import {
  issues,
  notifications,
  orders,
  outlets,
  planningRuns,
  receipts,
  tripStops,
  trips,
  users,
} from '@waypoint/database';
import type {
  EntityType,
  IssueStatus,
  IssueType,
  NotificationPriority,
  NotificationType,
  OrderStatus,
  StopStatus,
} from '@waypoint/shared';
import { and, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';

type ReceiptDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

interface ReceiptStopRow {
  id: string;
  stopStatus: StopStatus;
  orderId: string;
  orderStatus: OrderStatus;
  outletId: string;
  depotId: string;
}

export interface ReceiptRow {
  id: string;
  stopId: string;
  confirmedBy: string;
  confirmedAt: Date;
}

interface IssueOrderRow {
  id: string;
  status: OrderStatus;
  outletId: string;
  depotId: string;
}

export interface IssueRow {
  id: string;
  orderId: string;
  type: IssueType;
  note: string | null;
  status: IssueStatus;
  createdBy: string;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
}

interface NotificationDraft {
  recipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entityType: EntityType;
  entityId: string;
  createdAt: Date;
}

interface InsertReceipt {
  stopId: string;
  confirmedBy: string;
  confirmedAt: Date;
}

interface InsertIssue {
  orderId: string;
  type: IssueType;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface ReceiptRepo {
  lockStop(db: ReceiptDb, orderScope: SQL, stopId: string): Promise<ReceiptStopRow | null>;
  findReceipt(db: ReceiptDb, stopId: string): Promise<ReceiptRow | null>;
  insertReceipt(db: ReceiptDb, row: InsertReceipt): Promise<ReceiptRow | null>;
  confirmOrder(db: ReceiptDb, orderId: string): Promise<boolean>;
  lockOrder(db: ReceiptDb, orderScope: SQL, orderId: string): Promise<IssueOrderRow | null>;
  findStopId(db: ReceiptDb, orderId: string): Promise<string | null>;
  insertIssue(db: ReceiptDb, row: InsertIssue): Promise<IssueRow>;
  listIssues(db: ReceiptDb, orderScope: SQL): Promise<IssueRow[]>;
  findIssue(db: ReceiptDb, orderScope: SQL, issueId: string): Promise<IssueRow | null>;
  /** Locks the issue row and returns it with its order's outlet and depot. */
  lockIssue(
    db: ReceiptDb,
    orderScope: SQL,
    issueId: string,
  ): Promise<(IssueRow & { outletId: string; depotId: string }) | null>;
  resolveIssue(
    db: ReceiptDb,
    issueId: string,
    resolution: { by: string; at: Date; note: string },
  ): Promise<IssueRow | null>;
  listDispatchers(db: ReceiptDb, depotId: string): Promise<{ id: string }[]>;
  listStoreManagers(db: ReceiptDb, outletId: string): Promise<{ id: string }[]>;
  insertNotifications(db: ReceiptDb, rows: readonly NotificationDraft[]): Promise<void>;
}

const stopColumns = {
  id: tripStops.id,
  stopStatus: tripStops.status,
  orderId: orders.id,
  orderStatus: orders.status,
  outletId: orders.outletId,
  depotId: planningRuns.depotId,
};

const receiptColumns = {
  id: receipts.id,
  stopId: receipts.stopId,
  confirmedBy: receipts.confirmedBy,
  confirmedAt: receipts.confirmedAt,
};

const issueColumns = {
  id: issues.id,
  orderId: issues.orderId,
  type: issues.type,
  note: issues.note,
  status: issues.status,
  createdBy: issues.createdBy,
  createdAt: issues.createdAt,
  resolvedBy: issues.resolvedBy,
  resolvedAt: issues.resolvedAt,
  resolution: issues.resolution,
};

export function createReceiptRepo(): ReceiptRepo {
  return {
    async lockStop(db, orderScope, stopId) {
      const rows = await db
        .select(stopColumns)
        .from(tripStops)
        .innerJoin(orders, eq(orders.id, tripStops.orderId))
        .innerJoin(trips, eq(trips.id, tripStops.tripId))
        .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
        .where(and(eq(tripStops.id, stopId), orderScope))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async findReceipt(db, stopId) {
      const rows = await db
        .select(receiptColumns)
        .from(receipts)
        .where(eq(receipts.stopId, stopId))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertReceipt(db, row) {
      const rows = await db
        .insert(receipts)
        .values(row)
        .onConflictDoNothing({ target: receipts.stopId })
        .returning(receiptColumns);
      return rows[0] ?? null;
    },

    async confirmOrder(db, orderId) {
      const rows = await db
        .update(orders)
        .set({ status: 'receipt_confirmed', version: sql`${orders.version} + 1` })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'delivered')))
        .returning({ id: orders.id });
      return rows.length === 1;
    },

    async lockOrder(db, orderScope, orderId) {
      const rows = await db
        .select({
          id: orders.id,
          status: orders.status,
          outletId: orders.outletId,
          depotId: outlets.depotId,
        })
        .from(orders)
        .innerJoin(outlets, eq(outlets.id, orders.outletId))
        .where(and(eq(orders.id, orderId), orderScope))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async findStopId(db, orderId) {
      const rows = await db
        .select({ id: tripStops.id })
        .from(tripStops)
        .where(eq(tripStops.orderId, orderId))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async insertIssue(db, row) {
      const rows = await db.insert(issues).values(row).returning(issueColumns);
      const created = rows[0];
      if (created === undefined) throw new Error('Expected a store issue');
      return created;
    },

    async listIssues(db, orderScope) {
      return db
        .select(issueColumns)
        .from(issues)
        .innerJoin(orders, eq(orders.id, issues.orderId))
        .where(orderScope)
        .orderBy(desc(issues.createdAt), desc(issues.id));
    },

    async findIssue(db, orderScope, issueId) {
      const rows = await db
        .select(issueColumns)
        .from(issues)
        .innerJoin(orders, eq(orders.id, issues.orderId))
        .where(and(eq(issues.id, issueId), orderScope))
        .limit(1);
      return rows[0] ?? null;
    },

    async lockIssue(db, orderScope, issueId) {
      const rows = await db
        .select({ ...issueColumns, outletId: orders.outletId, depotId: outlets.depotId })
        .from(issues)
        .innerJoin(orders, eq(orders.id, issues.orderId))
        .innerJoin(outlets, eq(outlets.id, orders.outletId))
        .where(and(eq(issues.id, issueId), orderScope))
        .limit(1)
        .for('update', { of: issues });
      return rows[0] ?? null;
    },

    async resolveIssue(db, issueId, resolution) {
      const rows = await db
        .update(issues)
        .set({
          status: 'resolved',
          resolvedBy: resolution.by,
          resolvedAt: resolution.at,
          resolution: resolution.note,
        })
        .where(and(eq(issues.id, issueId), eq(issues.status, 'open')))
        .returning(issueColumns);
      return rows[0] ?? null;
    },

    async listDispatchers(db, depotId) {
      return db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.role, 'dispatcher'), or(eq(users.depotId, depotId), isNull(users.depotId))),
        );
    },

    async listStoreManagers(db, outletId) {
      return db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'store_manager'), eq(users.outletId, outletId)));
    },

    async insertNotifications(db, rows) {
      if (rows.length === 0) return;
      await db.insert(notifications).values([...rows]);
    },
  };
}
