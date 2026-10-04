import type {
  Issue,
  NotificationFeedItem,
  Order,
  OrderStatus,
  StoreOrder,
  StoreOrderDetail,
  StoreWorkspace,
  TemperatureRequirement,
} from '@waypoint/shared';
import type {
  DeferralExtras,
  DeliveryExtras,
  IssueExtras,
  NoteExtras,
  Product,
  Reliability,
} from './contracts';

/**
 * The Figma scenario for the Store Manager (section D, frames S01–S07): outlet WF-F071 Gampola on
 * Fri 25 Sep 2026 at 11:40. Values are copied from the frames; where a frame shows only a total,
 * the lines behind it are filled in so the totals still match.
 *
 * Fixture ids are not UUIDs, so nothing here is ever sent to the real API.
 */

const at = (date: string, time: string) => `${date}T${time}:00.000+05:30`;
const product = (
  temp: TemperatureRequirement,
  sku: string,
  name: string,
  unitKg: number,
  usual: number,
): Product => ({
  sku,
  name,
  temp,
  unitKg,
  unitM3: Math.round(unitKg * (temp === 'chilled' ? 4 : 5)) / 1000,
  usual,
});

// S02 "Place order" lists the first five chilled lines; the tab counts give 14 chilled and 22 dry.
export const catalogue: Product[] = [
  product('chilled', 'FM-1L-12', 'Fresh milk 1 L', 12.4, 4),
  product('chilled', 'YG-1K-06', 'Set yoghurt 1 kg', 6.5, 3),
  product('chilled', 'CH-200-10', 'Cheese slices 200 g', 2.4, 3),
  product('chilled', 'CS-500-08', 'Chicken sausages', 4.3, 2),
  product('chilled', 'BT-400-06', 'Butter 400 g', 2.6, 2),
  product('chilled', 'FC-500-12', 'Fresh cream 500 ml', 6.4, 2),
  product('chilled', 'CM-180-24', 'Chocolate milk 180 ml', 4.8, 3),
  product('chilled', 'CD-400-12', 'Curd 400 g', 5.2, 4),
  product('chilled', 'PN-200-12', 'Paneer 200 g', 2.8, 2),
  product('chilled', 'CK-1K-10', 'Chicken breast 1 kg', 10.4, 3),
  product('chilled', 'FF-500-10', 'Fish fillets 500 g', 5.4, 2),
  product('chilled', 'MZ-200-08', 'Mozzarella 200 g', 1.9, 1),
  product('chilled', 'OJ-1L-08', 'Orange juice 1 L', 8.6, 2),
  product('chilled', 'EG-10-12', 'Eggs 10 pack', 7.4, 3),
  product('chilled', 'HM-150-10', 'Sliced ham 150 g', 1.6, 1),
  product('ambient', 'RC-5K-02', 'Samba rice 5 kg', 10, 3),
  product('ambient', 'RB-1K-10', 'Basmati rice 1 kg', 10, 3),
  product('ambient', 'DL-1K-10', 'Red lentils 1 kg', 10, 2),
  product('ambient', 'SG-1K-10', 'White sugar 1 kg', 10, 3),
  product('ambient', 'FL-1K-10', 'Wheat flour 1 kg', 10, 2),
  product('ambient', 'TE-400-12', 'Ceylon tea 400 g', 4.8, 2),
  product('ambient', 'CO-1L-06', 'Coconut oil 1 L', 5.6, 2),
  product('ambient', 'CN-400-24', 'Coconut milk 400 ml', 9.6, 2),
  product('ambient', 'ND-400-20', 'Noodles 400 g', 8, 1),
  product('ambient', 'CR-200-24', 'Cream crackers 200 g', 4.8, 2),
  product('ambient', 'CP-100-24', 'Curry powder 100 g', 2.4, 2),
  product('ambient', 'CL-100-24', 'Chilli powder 100 g', 2.4, 1),
  product('ambient', 'SL-1K-12', 'Table salt 1 kg', 12, 1),
  product('ambient', 'MP-400-12', 'Milk powder 400 g', 4.8, 2),
  product('ambient', 'TS-340-12', 'Tomato sauce 340 g', 4.1, 1),
  product('ambient', 'JM-450-12', 'Mixed fruit jam 450 g', 5.4, 1),
  product('ambient', 'SO-100-48', 'Bath soap 100 g', 4.8, 1),
  product('ambient', 'DT-1K-08', 'Detergent 1 kg', 8, 1),
  product('ambient', 'TR-10-06', 'Toilet rolls 10 pack', 1.5, 1),
  product('ambient', 'TB-100-24', 'Tea bags 100 pack', 2, 1),
  product('ambient', 'BP-50-24', 'Black pepper 50 g', 1.2, 1),
  product('ambient', 'CF-425-10', 'Canned mackerel 425 g', 4.2, 1),
];

/** S01 and S02: the draft for Sat 26 Sep. 14 chilled lines, 186 kg; 22 dry lines, 158 kg. */
export const draftQuantities: Record<string, number> = {
  'FM-1L-12': 4,
  'YG-1K-06': 3,
  'CH-200-10': 3,
  'CS-500-08': 0,
  'BT-400-06': 2,
  'FC-500-12': 2,
  'CM-180-24': 3,
  'CD-400-12': 4,
  'PN-200-12': 2,
  'CK-1K-10': 1,
  'FF-500-10': 2,
  'MZ-200-08': 1,
  'OJ-1L-08': 2,
  'EG-10-12': 1,
  'HM-150-10': 2,
  'RC-5K-02': 1,
  'RB-1K-10': 1,
  'DL-1K-10': 1,
  'SG-1K-10': 1,
  'FL-1K-10': 1,
  'TE-400-12': 2,
  'CO-1L-06': 2,
  'CN-400-24': 1,
  'ND-400-20': 1,
  'CR-200-24': 2,
  'CP-100-24': 2,
  'CL-100-24': 1,
  'SL-1K-12': 1,
  'MP-400-12': 2,
  'TS-340-12': 1,
  'JM-450-12': 1,
  'SO-100-48': 1,
  'DT-1K-08': 1,
  'TR-10-06': 1,
  'TB-100-24': 1,
  'BP-50-24': 1,
  'CF-425-10': 1,
};
export const draftDate = '2026-09-26';

const outlet: StoreWorkspace['outlet'] = {
  id: 'WF-F071',
  brand: 'Fresh',
  district: 'Gampola',
  depotId: 'KANDY',
  dockType: 'rear_dock',
  parkingConstraint: 'van_only',
  window: { open: '05:30', close: '07:45' },
  mallWindow: null,
};

const USER = 'fixture-store-manager';

function order(
  id: string,
  temp: TemperatureRequirement,
  requestedDate: string,
  status: OrderStatus,
  size: [units: number, weightKg: number, volumeM3: number],
  submittedAt: string,
  lockedAt: string | null = null,
): Order {
  const [units, weightKg, volumeM3] = size;
  return {
    id,
    outletId: outlet.id,
    brand: 'Fresh',
    temp,
    requestedDate,
    units,
    weightKg,
    volumeM3,
    status,
    submittedAt,
    lockedAt,
    version: 1,
  };
}

// S04: today's chilled delivery on VEH051, on the way.
const today = order(
  'ORD-260925-0712',
  'chilled',
  '2026-09-25',
  'dispatched',
  [10, 68.5, 0.27],
  at('2026-09-24', '11:43'),
  at('2026-09-24', '16:00'),
);
// S06 and S07: yesterday's chilled delivery, delivered with 3 yoghurt short, receipt still open.
const delivered = order(
  'ORD-260924-0708',
  'chilled',
  '2026-09-24',
  'delivered',
  [10, 76.3, 0.31],
  at('2026-09-23', '11:20'),
  at('2026-09-23', '16:00'),
);
// S01 "Last delivery" history.
const closed = order(
  'ORD-260923-0702',
  'ambient',
  '2026-09-23',
  'receipt_confirmed',
  [26, 142, 0.71],
  at('2026-09-22', '10:58'),
  at('2026-09-22', '16:00'),
);
// S02a: a top-up sent at 16:07, seven minutes after the cutoff, and held for Mon 28 Sep.
const heldChilled = order(
  'ORD-260925-1611',
  'chilled',
  '2026-09-28',
  'submitted',
  [6, 42, 0.17],
  at('2026-09-25', '16:07'),
);
const heldDry = order(
  'ORD-260925-1612',
  'ambient',
  '2026-09-28',
  'submitted',
  [9, 61, 0.31],
  at('2026-09-25', '16:07'),
);
// S05-W: a chilled order moved from Sat 26 to Mon 28. Opened from its notification.
const deferred = order(
  'ORD-260926-0719',
  'chilled',
  '2026-09-26',
  'deferred',
  [58, 377, 1.51],
  at('2026-09-25', '10:12'),
  at('2026-09-25', '16:00'),
);

const access = (item: Order, cutoffDate: string, editable: boolean): StoreOrder => ({
  order: item,
  cutoffAt: at(cutoffDate, '16:00'),
  editable,
});

const issues: Issue[] = [
  {
    id: 'ISS-0431',
    orderId: delivered.id,
    type: 'missing',
    note: '3 cartons short · Set yoghurt 1 kg',
    status: 'open',
    createdBy: 'planning',
    createdAt: at('2026-09-24', '04:24'),
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
  },
  {
    id: 'ISS-0418',
    orderId: closed.id,
    type: 'damaged',
    note: '1 bread tray damaged',
    status: 'resolved',
    createdBy: USER,
    createdAt: at('2026-09-22', '06:20'),
    resolvedBy: 'planning',
    resolvedAt: at('2026-09-22', '09:10'),
    resolution: 'Credit note raised for the damaged tray',
  },
  {
    id: 'ISS-0407',
    orderId: closed.id,
    type: 'incorrect',
    note: 'Wrong cheese SKU',
    status: 'resolved',
    createdBy: USER,
    createdAt: at('2026-09-19', '06:41'),
    resolvedBy: 'planning',
    resolvedAt: at('2026-09-19', '10:05'),
    resolution: 'Correct SKU sent on the next run',
  },
];

export const workspace: StoreWorkspace = {
  serverNow: at('2026-09-25', '11:40'),
  outlet,
  cutoffAt: at('2026-09-25', '16:00'),
  nextServiceDate: draftDate,
  eligibleServiceDate: draftDate,
  serviceDates: [
    { date: '2026-09-26', cutoffAt: at('2026-09-25', '16:00') },
    { date: '2026-09-28', cutoffAt: at('2026-09-26', '16:00') },
  ],
  orders: [
    access(heldChilled, '2026-09-26', true),
    access(heldDry, '2026-09-26', true),
    access(today, '2026-09-24', false),
    access(delivered, '2026-09-23', false),
    access(closed, '2026-09-22', false),
  ],
  issues,
};

const pending = { delivery: null, deferral: null, issues: [] };

export const details: Record<string, StoreOrderDetail> = {
  [today.id]: {
    ...access(today, '2026-09-24', false),
    // Frame S04 is drawn at 05:44, fifteen minutes after the driver's last report.
    serverNow: at('2026-09-25', '05:44'),
    outlet,
    delivery: {
      stopId: 'STOP-051-1',
      vehicleId: 'VEH051',
      tripStatus: 'departed',
      status: 'pending',
      serviceDate: '2026-09-25',
      plannedArrival: at('2026-09-25', '05:41'),
      eta: at('2026-09-25', '05:41'),
      late: false,
      publishedAt: at('2026-09-24', '17:10'),
      lastUpdatedAt: at('2026-09-25', '05:29'),
      updateDelayed: true,
      deliveredAt: null,
      failureReason: null,
      pod: null,
      receipt: null,
    },
    deferral: null,
    issues: [],
  },
  [delivered.id]: {
    ...access(delivered, '2026-09-23', false),
    serverNow: at('2026-09-25', '11:40'),
    outlet,
    delivery: {
      stopId: 'STOP-051-0',
      vehicleId: 'VEH051',
      tripStatus: 'completed',
      status: 'delivered',
      serviceDate: '2026-09-24',
      plannedArrival: at('2026-09-24', '05:41'),
      eta: at('2026-09-24', '05:41'),
      late: false,
      publishedAt: at('2026-09-23', '17:10'),
      lastUpdatedAt: at('2026-09-24', '06:02'),
      updateDelayed: false,
      deliveredAt: at('2026-09-24', '05:41'),
      failureReason: null,
      pod: {
        id: 'POD-051-0',
        stopId: 'STOP-051-0',
        recipientName: 'T. Jayasinghe',
        hasPhoto: true,
        clientTime: at('2026-09-24', '05:44'),
      },
      receipt: null,
    },
    deferral: null,
    issues: issues.filter((item) => item.orderId === delivered.id),
  },
  [closed.id]: {
    ...access(closed, '2026-09-22', false),
    serverNow: at('2026-09-25', '11:40'),
    outlet,
    delivery: {
      stopId: 'STOP-014-2',
      vehicleId: 'VEH014',
      tripStatus: 'completed',
      status: 'delivered',
      serviceDate: '2026-09-23',
      plannedArrival: at('2026-09-23', '05:48'),
      eta: at('2026-09-23', '05:52'),
      late: false,
      publishedAt: at('2026-09-22', '17:10'),
      lastUpdatedAt: at('2026-09-23', '05:52'),
      updateDelayed: false,
      deliveredAt: at('2026-09-23', '05:52'),
      failureReason: null,
      pod: {
        id: 'POD-014-2',
        stopId: 'STOP-014-2',
        recipientName: 'T. Jayasinghe',
        hasPhoto: true,
        clientTime: at('2026-09-23', '05:53'),
      },
      receipt: {
        id: 'RCP-014-2',
        stopId: 'STOP-014-2',
        confirmedBy: USER,
        confirmedAt: at('2026-09-23', '06:04'),
      },
    },
    deferral: null,
    issues: issues.filter((item) => item.orderId === closed.id),
  },
  [heldChilled.id]: {
    ...access(heldChilled, '2026-09-26', true),
    serverNow: at('2026-09-25', '16:07'),
    outlet,
    ...pending,
  },
  [heldDry.id]: {
    ...access(heldDry, '2026-09-26', true),
    serverNow: at('2026-09-25', '16:07'),
    outlet,
    ...pending,
  },
  [deferred.id]: {
    ...access(deferred, '2026-09-25', false),
    serverNow: at('2026-09-25', '17:53'),
    outlet: { ...outlet, window: { open: '06:30', close: '08:30' } },
    delivery: null,
    deferral: {
      reasonCode: 'REEFER_REQUIRED',
      type: 'unavoidable',
      note: null,
      createdAt: at('2026-09-25', '17:44'),
      serviceDate: '2026-09-26',
      nextEligibleDate: '2026-09-28',
    },
    issues: [],
  },
};

/** Line counts the frames print next to a weight ("3 lines · 42 kg"). */
export const lineCounts: Record<string, number> = {
  [heldChilled.id]: 3,
  [heldDry.id]: 5,
  [deferred.id]: 12,
  [closed.id]: 9,
};
/** S06-W table: ordered cartons per product, and what the driver handed over. */
export const orderLines: Record<string, { sku: string; qty: number; handedOver?: number }[]> = {
  [today.id]: [
    { sku: 'FM-1L-12', qty: 4 },
    { sku: 'CH-200-10', qty: 3 },
    { sku: 'YG-1K-06', qty: 3 },
  ],
  [delivered.id]: [
    { sku: 'FM-1L-12', qty: 4, handedOver: 4 },
    { sku: 'CH-200-10', qty: 3, handedOver: 3 },
    { sku: 'YG-1K-06', qty: 3, handedOver: 0 },
  ],
};

const yoghurtShort = (date: string) => ({
  sku: 'YG-1K-06',
  label: 'yoghurt',
  qty: 3,
  toldAt: at(date, '04:24'),
  topUp: { vehicleId: 'VEH007', tripNo: 2, eta: at(date, '09:50') },
});
const driver = {
  driverName: 'Suresh Kumar',
  driverPhone: '+94 77 555 0151',
  vehicleLabel: 'reefer van',
};

export const deliveries: Record<string, DeliveryExtras> = {
  [today.id]: {
    ...driver,
    stopNo: 1,
    stopCount: 3,
    recordedFrom: at('2026-09-25', '04:41'),
    prepare: [
      { icon: 'user', text: '2 staff at the rear lane' },
      { icon: 'snow', text: 'Chilled space for 7 cartons' },
      { icon: 'nav', text: 'Van-only lane clear' },
    ],
    shortage: yoghurtShort('2026-09-25'),
    podSyncedAt: null,
  },
  [delivered.id]: {
    ...driver,
    stopNo: 1,
    stopCount: 3,
    recordedFrom: at('2026-09-24', '04:41'),
    prepare: [
      { icon: 'boxc', text: '7 cartons handed over · T. Jayasinghe signed' },
      { icon: 'file', text: 'Driver POD: signature + photo' },
      { icon: 'check', text: 'Confirm receipt or report an issue' },
    ],
    shortage: yoghurtShort('2026-09-24'),
    podSyncedAt: at('2026-09-24', '06:02'),
  },
  [closed.id]: {
    driverName: 'Ajith Ranasinghe',
    driverPhone: '+94 77 555 0114',
    vehicleLabel: 'dry box truck',
    stopNo: 2,
    stopCount: 5,
    recordedFrom: at('2026-09-23', '04:55'),
    prepare: [{ icon: 'check', text: 'Receipt confirmed · nothing else to do' }],
    shortage: null,
    podSyncedAt: at('2026-09-23', '05:53'),
  },
};

/** S07: the open issue, with its top-up and timeline, then the two resolved ones. */
export const issueDetails: Record<string, IssueExtras> = {
  'ISS-0431': {
    title: '3 yoghurt short',
    summary: 'Set yoghurt 1 kg · 3 short',
    reportedBy: 'planning',
    ordered: 10,
    received: 7,
    short: 3,
    unit: 'cartons',
    fix: {
      title: 'Top-up on VEH007 trip 2',
      detail: 'ETA 09:50 · 3 cartons · no action needed',
      status: 'Planned',
    },
    timeline: [
      { at: at('2026-09-24', '04:21'), text: 'Loader found 3 missing at Kandy dock 2', done: true },
      { at: at('2026-09-24', '04:24'), text: 'You were told before the van left', done: true },
      { at: at('2026-09-24', '06:15'), text: 'Receipt confirmed · 7 of 10', done: true },
      { at: at('2026-09-24', '09:50'), text: 'Top-up arrives · confirm to close', done: false },
    ],
  },
  'ISS-0418': {
    title: '1 bread tray damaged',
    summary: 'Sandwich bread · 1 tray damaged',
    reportedBy: 'you',
    ordered: 6,
    received: 5,
    short: 1,
    unit: 'trays',
    fix: {
      title: 'Credited to your account',
      detail: 'Credit note CN-2291 · Rs 1,840',
      status: 'Done',
    },
    timeline: [
      {
        at: at('2026-09-22', '06:20'),
        text: 'You reported 1 damaged tray with a photo',
        done: true,
      },
      { at: at('2026-09-22', '08:05'), text: 'Planning approved a credit', done: true },
      { at: at('2026-09-24', '10:30'), text: 'Credit note issued · closed', done: true },
    ],
  },
  'ISS-0407': {
    title: 'Wrong cheese SKU',
    summary: 'Cheese slices 200 g · wrong item',
    reportedBy: 'you',
    ordered: 3,
    received: 0,
    short: 3,
    unit: 'cartons',
    fix: {
      title: 'Swapped on the next run',
      detail: 'Correct cartons arrived Tue 22 Sep',
      status: 'Done',
    },
    timeline: [
      {
        at: at('2026-09-19', '06:41'),
        text: 'You reported 3 cartons of the wrong cheese',
        done: true,
      },
      { at: at('2026-09-19', '09:12'), text: 'Planning booked a swap for Tuesday', done: true },
      { at: at('2026-09-22', '05:52'), text: 'Swap delivered · closed', done: true },
    ],
  },
};
/** S07 list: the short second line of each row, after the date. */
export const issueOutcome: Record<string, string> = {
  'ISS-0431': 'VEH051 · pre-notified',
  'ISS-0418': 'credited',
  'ISS-0407': 'swapped Tue',
};

export const deferralDetails: Record<string, DeferralExtras> = {
  [deferred.id]: { decidedBy: 'N. Fernando', code: 'R-03' },
};
/** S05-W "Your last 4 orders": oldest first, true when that order was moved. */
export const moves: boolean[] = [false, false, false, true];

// S01 "On-time arrivals": 11 of 12 inside the window, one late on Sat 12 Sep.
export const reliability: Reliability = {
  deltaPct: 6,
  arrivals: [
    '2026-09-05',
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-14',
    '2026-09-16',
    '2026-09-18',
    '2026-09-21',
    '2026-09-23',
  ].map((date) => ({ date, lateMin: date === '2026-09-12' ? 22 : null })),
};

export const planningPhone = '+94 81 555 0142';

const note = (
  id: string,
  type: NotificationFeedItem['type'],
  entityId: string,
  createdAt: string,
  open: boolean,
): NotificationFeedItem => ({
  id,
  recipientId: USER,
  type,
  priority: open ? 'high' : 'info',
  entityType: 'order',
  entityId,
  createdAt,
  readAt: open ? null : createdAt,
  acknowledgedAt: open ? null : createdAt,
  actionRequired: open,
});

// Prototype I29 "Notifications", retold for this outlet.
export const notifications: NotificationFeedItem[] = [
  note('NTF-5', 'order_deferred', deferred.id, at('2026-09-25', '17:53'), true),
  note('NTF-4', 'delivered', delivered.id, at('2026-09-24', '06:02'), true),
  note('NTF-3', 'order_confirmed', heldChilled.id, at('2026-09-25', '16:07'), false),
  note('NTF-2', 'plan_published', today.id, at('2026-09-24', '17:10'), false),
  note('NTF-1', 'order_confirmed', today.id, at('2026-09-24', '11:43'), false),
];
export const noteDetails: Record<string, NoteExtras> = {
  'NTF-5': {
    title: 'Order deferred · ORD-260926-0719',
    detail: 'Chilled moves from Sat 26 to Mon 28 · refrigerated vans are full',
  },
  'NTF-4': {
    title: 'Delivery completed · ORD-260924-0708',
    detail: 'Delivered 05:41 · awaiting your receipt confirmation',
  },
  'NTF-3': {
    title: 'Order held after cutoff · ORD-260925-1611',
    detail: 'Submitted 16:07 · held for Mon 28 Sep',
    to: '/store/orders/ORD-260925-1611/held',
  },
  'NTF-2': {
    title: 'Delivery scheduled · ORD-260925-0712',
    detail: 'Expected 05:41 · window 05:30–07:45 · VEH051',
  },
  'NTF-1': {
    title: 'Order confirmed · ORD-260925-0712',
    detail: 'Received by planning · ETA window by 18:00',
  },
};
