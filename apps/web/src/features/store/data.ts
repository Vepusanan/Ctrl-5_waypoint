import {
  type CreateIssueRequest,
  type CreateOrderRequest,
  type Issue,
  issueSchema,
  type NotificationFeedItem,
  type NotificationType,
  notificationFeedItemSchema,
  notificationListResponseSchema,
  type Order,
  orderSchema,
  type Receipt,
  receiptSchema,
  type StoreOrderDetail,
  type StoreWorkspace,
  storeOrderDetailSchema,
  storeWorkspaceSchema,
  type TemperatureRequirement,
} from '@waypoint/shared';
import { api, HttpError } from '../../lib/api';
import { clock } from '../../lib/format';
import type {
  DeferralExtras,
  DeliveryExtras,
  IssueExtras,
  NoteExtras,
  OrderLine,
  Product,
  ReceiptLine,
  Reliability,
} from './contracts';
import * as fixtures from './fixtures';

/**
 * The Store Manager pages' only way to data. Two halves:
 *
 * - `storeApi`: the requests. They go to the real API, or to the Figma scenario in
 *   `fixtures.ts` when fixtures are on. Both answer with the `@waypoint/shared` shapes.
 * - `insights`: what the frames show and the API does not return yet (`contracts.ts`). With
 *   fixtures on they come from Figma; otherwise they are derived from the API response.
 *
 * Fixtures are on with `VITE_STORE_FIXTURES=all`, or, on the dev server only, for one tab by opening
 * `/store?fixtures=on` (`?fixtures=off` turns them off again).
 */
const TAB_KEY = 'waypoint.store.fixtures';
function readMode(): boolean {
  // The per-tab switch is a development aid. A deployed build never lets a URL swap a store's
  // real orders for the Figma scenario, where placing an order reaches no one.
  if (!import.meta.env.DEV) return import.meta.env.VITE_STORE_FIXTURES === 'all';
  try {
    const asked = new URLSearchParams(window.location.search).get('fixtures');
    if (asked === 'on' || asked === 'off') window.sessionStorage.setItem(TAB_KEY, asked);
    const kept = window.sessionStorage.getItem(TAB_KEY);
    if (kept) return kept === 'on';
  } catch {
    // Storage can be blocked; the build setting still applies.
  }
  return import.meta.env.VITE_STORE_FIXTURES === 'all';
}
const fixtureMode = readMode();

// ── Fixture state: changes last until the tab is refreshed. ────────────────────────────────
const fx = {
  loadedAt: Date.now(),
  workspace: structuredClone(fixtures.workspace),
  details: structuredClone(fixtures.details),
  notes: structuredClone(fixtures.notifications),
  draftCleared: false,
  orderNo: 712,
  issueNo: 432,
};
const answer = <T>(value: T) =>
  new Promise<T>((resolve) => window.setTimeout(() => resolve(structuredClone(value)), 300));
const fixtureNow = () =>
  new Date(Date.parse(fixtures.workspace.serverNow) + Date.now() - fx.loadedAt);
/** API timestamps carry the Colombo offset. */
const stamp = (date: Date) =>
  `${new Date(date.getTime() + 19_800_000).toISOString().slice(0, 23)}+05:30`;
const missing = () => new HttpError(404, 'NOT_FOUND', 'That order is not in this demo scenario.');

type Size = Pick<Order, 'units' | 'weightKg' | 'volumeM3'>;

export const storeApi = {
  workspace(): Promise<StoreWorkspace> {
    if (!fixtureMode) return api('/store/workspace', storeWorkspaceSchema);
    return answer({ ...fx.workspace, serverNow: stamp(fixtureNow()) });
  },
  order(id: string): Promise<StoreOrderDetail> {
    if (!fixtureMode) return api(`/store/orders/${id}`, storeOrderDetailSchema);
    const detail = fx.details[id];
    return detail ? answer(detail) : Promise.reject(missing());
  },
  createOrder(body: CreateOrderRequest): Promise<Order> {
    if (!fixtureMode) {
      return api('/orders', orderSchema, { method: 'POST', body: JSON.stringify(body) });
    }
    const now = fixtureNow();
    const created: Order = {
      id: `ORD-${body.requestedDate.slice(2).replaceAll('-', '')}-0${fx.orderNo++}`,
      outletId: fx.workspace.outlet.id,
      brand: fx.workspace.outlet.brand,
      temp: body.temp,
      requestedDate: body.requestedDate,
      units: body.units,
      weightKg: body.weightKg,
      volumeM3: body.volumeM3,
      status: 'confirmed',
      submittedAt: stamp(now),
      lockedAt: null,
      version: 1,
    };
    const access = { order: created, cutoffAt: fx.workspace.cutoffAt, editable: true };
    fx.workspace.orders.unshift(access);
    fx.details[created.id] = {
      ...access,
      serverNow: stamp(now),
      outlet: fx.workspace.outlet,
      delivery: null,
      deferral: null,
      issues: [],
    };
    return answer(created);
  },
  updateOrder(order: Order, size: Size): Promise<Order> {
    if (!fixtureMode) {
      return api(`/orders/${order.id}`, orderSchema, {
        method: 'PATCH',
        headers: { 'If-Match': String(order.version) },
        body: JSON.stringify(size),
      });
    }
    const detail = fx.details[order.id];
    if (!detail) return Promise.reject(missing());
    detail.order = { ...detail.order, ...size, version: detail.order.version + 1 };
    for (const item of fx.workspace.orders) {
      if (item.order.id === order.id) item.order = detail.order;
    }
    return answer(detail.order);
  },
  confirmReceipt(stopId: string): Promise<Receipt> {
    if (!fixtureMode) return api(`/stops/${stopId}/receipt`, receiptSchema, { method: 'POST' });
    const detail = Object.values(fx.details).find((item) => item.delivery?.stopId === stopId);
    if (!detail?.delivery) return Promise.reject(missing());
    const receipt: Receipt = {
      id: `RCP-${stopId}`,
      stopId,
      confirmedBy: 'fixture-store-manager',
      confirmedAt: stamp(fixtureNow()),
    };
    detail.delivery.receipt = receipt;
    detail.order = { ...detail.order, status: 'receipt_confirmed' };
    for (const item of fx.workspace.orders) {
      if (item.order.id === detail.order.id) item.order = detail.order;
    }
    return answer(receipt);
  },
  reportIssue(body: CreateIssueRequest): Promise<Issue> {
    if (!fixtureMode) {
      return api('/issues', issueSchema, { method: 'POST', body: JSON.stringify(body) });
    }
    const issue: Issue = {
      id: `ISS-0${fx.issueNo++}`,
      orderId: body.orderId,
      type: body.type,
      note: body.note ?? null,
      status: 'open',
      createdBy: 'fixture-store-manager',
      createdAt: stamp(fixtureNow()),
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
    };
    fx.workspace.issues.unshift(issue);
    fx.details[body.orderId]?.issues.unshift(issue);
    return answer(issue);
  },
  async notifications(): Promise<NotificationFeedItem[]> {
    if (fixtureMode) return answer(fx.notes);
    return (await api('/notifications', notificationListResponseSchema)).items;
  },
  /** Marks one notice read; a notice that needs an answer is acknowledged as well. */
  async readNotification(item: NotificationFeedItem): Promise<void> {
    if (fixtureMode) {
      const now = stamp(fixtureNow());
      fx.notes = fx.notes.map((note) =>
        note.id === item.id
          ? { ...note, readAt: now, acknowledgedAt: now, actionRequired: false }
          : note,
      );
      return;
    }
    await api(`/notifications/${item.id}/read`, notificationFeedItemSchema, { method: 'POST' });
    if (item.actionRequired) {
      await api(`/notifications/${item.id}/acknowledge`, notificationFeedItemSchema, {
        method: 'POST',
      });
    }
  },
};

// ── Order names and lines ──────────────────────────────────────────────────────────────────

/** "ORD-260926-0712". The API has no order number yet, so a live order shows part of its id. */
export const orderName = (id: string) =>
  id.startsWith('ORD-') ? id : `ORD-${id.slice(0, 8).toUpperCase()}`;

export const catalogueFor = (brand: string): Product[] =>
  brand === 'Fresh'
    ? fixtures.catalogue
    : fixtures.catalogue.filter((item) => item.temp === 'ambient');

const bySku = new Map(fixtures.catalogue.map((item) => [item.sku, item]));
const round = (value: number, digits: number) => Number(value.toFixed(digits));

export function totals(lines: readonly OrderLine[]) {
  const used = lines.filter((line) => line.qty > 0);
  return {
    lines: used.length,
    units: used.reduce((sum, line) => sum + line.qty, 0),
    weightKg: round(
      used.reduce((sum, line) => sum + line.qty * line.product.unitKg, 0),
      1,
    ),
    volumeM3: round(
      used.reduce((sum, line) => sum + line.qty * line.product.unitM3, 0),
      3,
    ),
  };
}

function read(key: string): Record<string, number> | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? (value as Record<string, number>) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: Record<string, number> | null) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {
    // Without storage the lines are simply not remembered.
  }
}
const linesKey = (orderId: string) => `waypoint.store.lines.${orderId}`;
const draftKey = (outletId: string, date: string) => `waypoint.store.draft.${outletId}.${date}`;

/** Spreads an order's cartons over the first `count` products of its temperature. */
function spread(temp: TemperatureRequirement, units: number, count: number): OrderLine[] {
  const products = fixtures.catalogue.filter((item) => item.temp === temp);
  const used = products.slice(0, Math.max(1, Math.min(count, units, products.length)));
  const base = Math.floor(units / used.length);
  const extra = units - base * used.length;
  return used.map((product, index) => ({ product, qty: base + (index < extra ? 1 : 0) }));
}

/**
 * The product lines of an order. The API stores a size only, so the lines are the ones this
 * browser sent (kept in local storage), or else a spread of the order's cartons.
 */
export function linesFor(order: Order): OrderLine[] {
  const fixed = fixtureMode ? fixtures.orderLines[order.id] : undefined;
  if (fixed) {
    return fixed.flatMap((line) => {
      const product = bySku.get(line.sku);
      return product ? [{ product, qty: line.qty }] : [];
    });
  }
  const saved = read(linesKey(order.id));
  if (saved) {
    const lines = Object.entries(saved).flatMap(([sku, qty]) => {
      const product = bySku.get(sku);
      return product && qty > 0 ? [{ product, qty }] : [];
    });
    if (lines.length) return lines;
  }
  const count = (fixtureMode ? fixtures.lineCounts[order.id] : undefined) ?? 6;
  return spread(order.temp, order.units, count);
}
export function rememberLines(orderId: string, lines: readonly OrderLine[]) {
  write(
    linesKey(orderId),
    Object.fromEntries(lines.filter((line) => line.qty > 0).map((l) => [l.product.sku, l.qty])),
  );
}

/** Saved quantities for an order that has not been sent ("Save draft" on S02). */
export function readDraft(outletId: string, date: string): Record<string, number> {
  const saved = read(draftKey(outletId, date));
  if (saved) return saved;
  return fixtureMode && !fx.draftCleared && date === fixtures.draftDate
    ? fixtures.draftQuantities
    : {};
}
export function saveDraft(outletId: string, date: string, quantities: Record<string, number>) {
  write(draftKey(outletId, date), quantities);
}
export function clearDraft(outletId: string, date: string) {
  write(draftKey(outletId, date), null);
  if (date === fixtures.draftDate) fx.draftCleared = true;
}

// ── What the API does not return yet ───────────────────────────────────────────────────────

const dockName = { rear_dock: 'rear dock', street: 'street door', mall_bay: 'mall bay' } as const;

const issueLabel = (type: Issue['type']) =>
  type === 'missing' ? 'Short delivery' : type === 'incorrect' ? 'Wrong item' : 'Damaged goods';

const noteCopy: Record<NotificationType, [title: string, detail: string]> = {
  order_confirmed: ['Order confirmed', 'Received by planning · ETA window by 18:00'],
  order_deferred: ['Order deferred', 'Planning moved this order · open the notice to see why'],
  plan_published: ['Delivery scheduled', 'Your expected arrival is ready'],
  plan_changed: ['Delivery plan changed', 'Your expected arrival may have moved'],
  loading_shortfall: ['Loading shortfall', 'Part of this order could not be loaded'],
  delivery_failed: ['Delivery failed', 'The driver could not complete this delivery'],
  delivery_issue: ['Delivery issue', 'The driver reported a problem at your stop'],
  delivered: ['Delivery completed', 'Awaiting your receipt confirmation'],
  receipt_discrepancy: ['Receipt issue sent to planning', 'Planning decides the fix'],
  sync_conflict: ['A field update needs review', 'Planning is checking the record'],
  issue_resolved: ['Issue resolved by planning', 'Open Issues to read what was decided'],
};

export const insights = {
  reliability(workspace: StoreWorkspace): Reliability {
    if (fixtureMode) return fixtures.reliability;
    // Gap: the workspace does not say whether a past delivery was late, so none is marked late.
    const arrivals = workspace.orders
      .filter((item) => ['delivered', 'receipt_confirmed'].includes(item.order.status))
      .map((item) => item.order.requestedDate)
      .filter((date, index, all) => all.indexOf(date) === index)
      .sort()
      .slice(-12)
      .map((date) => ({ date, lateMin: null }));
    return { arrivals, deltaPct: null };
  },
  delivery(detail: StoreOrderDetail): DeliveryExtras {
    const fixed = fixtureMode ? fixtures.deliveries[detail.order.id] : undefined;
    if (fixed) return fixed;
    const { order, outlet, delivery } = detail;
    const chilled = order.temp === 'chilled';
    const prepare = delivery?.deliveredAt
      ? [
          { icon: 'boxc', text: `${order.units} cartons handed over` },
          {
            icon: 'file',
            text: delivery.pod
              ? `Signed by ${delivery.pod.recipientName}${delivery.pod.hasPhoto ? ' · photo on file' : ''}`
              : 'Driver proof of delivery',
          },
          { icon: 'check', text: 'Confirm receipt or report an issue' },
        ]
      : [
          {
            icon: 'user',
            text: `Staff at the ${dockName[outlet.dockType]} from ${outlet.window.open}`,
          },
          chilled
            ? { icon: 'snow', text: `Chilled space for ${order.units} cartons` }
            : { icon: 'box', text: `Shelf space for ${order.units} cartons` },
          ...(outlet.parkingConstraint === 'van_only'
            ? [{ icon: 'nav', text: 'Van-only lane clear' }]
            : outlet.mallWindow
              ? [
                  {
                    icon: 'clock',
                    text: `Mall access ${outlet.mallWindow.open}–${outlet.mallWindow.close}`,
                  },
                ]
              : []),
        ];
    return {
      driverName: null,
      driverPhone: null,
      vehicleLabel: chilled ? 'refrigerated vehicle' : 'delivery vehicle',
      stopNo: null,
      stopCount: null,
      recordedFrom: null,
      prepare,
      shortage: null,
      podSyncedAt: null,
    };
  },
  receiptLines(detail: StoreOrderDetail): ReceiptLine[] {
    const fixed = fixtureMode ? fixtures.orderLines[detail.order.id] : undefined;
    const lines = linesFor(detail.order);
    // Gap: the proof of delivery has no per-product counts, so it is taken to match the order.
    return lines.map((line) => ({
      ...line,
      handedOver: fixed?.find((item) => item.sku === line.product.sku)?.handedOver ?? line.qty,
    }));
  },
  issue(issue: Issue, workspace: StoreWorkspace, userId: string): IssueExtras {
    const fixed = fixtureMode ? fixtures.issueDetails[issue.id] : undefined;
    if (fixed) return fixed;
    const order = workspace.orders.find((item) => item.order.id === issue.orderId)?.order;
    const count = Number(/^(\d+)/.exec(issue.note ?? '')?.[1] ?? Number.NaN);
    const short = Number.isFinite(count) ? count : null;
    const title = issue.note?.split(' · ')[0] ?? issueLabel(issue.type);
    const resolved = issue.status === 'resolved';
    return {
      title,
      summary: `${orderName(issue.orderId)} · ${title}`,
      reportedBy: issue.createdBy === userId ? 'you' : 'planning',
      ordered: order?.units ?? null,
      received: order && short !== null ? Math.max(0, order.units - short) : null,
      short,
      unit: 'cartons',
      fix: resolved
        ? {
            title: 'Resolved by planning',
            // What the dispatcher wrote when closing the issue.
            detail: issue.resolution ?? 'Nothing else for you to do',
            status: 'Done',
          }
        : {
            title: 'With planning',
            detail: `Dispatcher alerted ${clock(issue.createdAt)} · no action needed from you`,
            status: 'Open',
          },
      timeline: [
        { at: issue.createdAt, text: 'Issue sent · dispatcher alerted', done: true },
        {
          at: issue.resolvedAt,
          text: resolved ? 'Resolved by planning' : 'Planning decides the fix',
          done: resolved,
        },
      ],
    };
  },
  issueOutcome(issue: Issue): string {
    const fixed = fixtureMode ? fixtures.issueOutcome[issue.id] : undefined;
    return fixed ?? (issue.status === 'open' ? 'with planning' : 'closed');
  },
  deferral(detail: StoreOrderDetail): DeferralExtras {
    const fixed = fixtureMode ? fixtures.deferralDetails[detail.order.id] : undefined;
    // Gap: the API has the reason code but not planning's reason number or the decider's name.
    return fixed ?? { decidedBy: null, code: detail.deferral?.reasonCode ?? '' };
  },
  /** The outlet's last four orders, oldest first; true when that order was deferred. */
  moves(workspace: StoreWorkspace): boolean[] {
    if (fixtureMode) return fixtures.moves;
    return [...workspace.orders]
      .filter((item) => item.order.status !== 'cancelled')
      .sort((a, b) => a.order.requestedDate.localeCompare(b.order.requestedDate))
      .slice(-4)
      .map((item) => item.order.status === 'deferred');
  },
  /**
   * Where the driver's signature or photo for a stop is served. The API checks that the stop
   * delivered to this outlet. The Figma scenario has no stored image, so it shows the mark.
   */
  podImage(stopId: string, kind: 'signature' | 'photo'): string | null {
    if (fixtureMode)
      return kind === 'signature' ? '/waypoint/store/2179-26669-imgVector.svg' : null;
    return `/api/v1/stops/${stopId}/pod/${kind}`;
  },
  /** Gap: the API has no planning desk number, so "Call planning" has nothing to dial live. */
  planningPhone: (): string | null => (fixtureMode ? fixtures.planningPhone : null),
  note(item: NotificationFeedItem): NoteExtras {
    const fixed = fixtureMode ? fixtures.noteDetails[item.id] : undefined;
    if (fixed) return fixed;
    const [title, detail] = noteCopy[item.type];
    return {
      title: item.entityType === 'order' ? `${title} · ${orderName(item.entityId)}` : title,
      detail,
    };
  },
};
