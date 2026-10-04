import { describe, expect, it } from 'vitest';
import {
  brandSchema,
  calendarDaySchema,
  deferralSchema,
  depotSchema,
  issueSchema,
  loadingIssueSchema,
  notificationPriorityByType,
  notificationRequiresAction,
  notificationTypeSchema,
  orderSchema,
  outletSchema,
  podSchema,
  reasonCodeSchema,
  stopEventInputSchema,
  stopEventSchema,
  temperatureRequirementSchema,
  tripSchema,
  tripStopSchema,
  userSchema,
  vehicleSchema,
} from '../src/index.ts';
import { colomboTime, ids, orderRow, outletRow, vehicleRow } from './fixtures.ts';

describe('enums', () => {
  it('accepts dataset values exactly as written in the CSVs', () => {
    expect(brandSchema.options).toEqual(['Fresh', 'Style', 'Tech']);
    expect(temperatureRequirementSchema.parse('chilled')).toBe('chilled');
  });

  it('rejects values in a different case', () => {
    expect(brandSchema.safeParse('fresh').success).toBe(false);
  });

  it('lists every hard-constraint rule from SYSTEM_DESIGN §7.2', () => {
    expect(reasonCodeSchema.options).toHaveLength(12);
    expect(reasonCodeSchema.options).toContain('REEFER_REQUIRED');
    expect(reasonCodeSchema.options).toContain('FUEL_QUOTA');
  });

  it('assigns a priority to every notification type', () => {
    expect(Object.keys(notificationPriorityByType).sort()).toEqual(
      [...notificationTypeSchema.options].sort(),
    );
    expect(notificationPriorityByType.order_confirmed).toBe('info');
    expect(notificationPriorityByType.order_deferred).toBe('high');
    expect(notificationPriorityByType.plan_published).toBe('high');
    expect(notificationPriorityByType.plan_changed).toBe('high');
    expect(notificationPriorityByType.loading_shortfall).toBe('high');
    expect(notificationPriorityByType.delivery_failed).toBe('high');
    expect(notificationPriorityByType.delivery_issue).toBe('high');
    expect(notificationPriorityByType.delivered).toBe('info');
    expect(notificationPriorityByType.receipt_discrepancy).toBe('high');
    expect(notificationPriorityByType.sync_conflict).toBe('medium');
  });

  it('keeps acknowledgement separate from priority for high-priority items', () => {
    expect(notificationRequiresAction('high', null)).toBe(true);
    expect(notificationRequiresAction('high', colomboTime)).toBe(false);
    expect(notificationRequiresAction('medium', null)).toBe(false);
    expect(notificationRequiresAction('info', null)).toBe(false);
  });
});

describe('reference data', () => {
  it('parses an outlet row', () => {
    expect(outletSchema.parse(outletRow)).toEqual(outletRow);
  });

  it('parses a mall outlet with its access window', () => {
    const mall = { ...outletRow, dockType: 'mall_bay', parkingConstraint: 'mall_dock' };
    const parsed = outletSchema.parse({ ...mall, mallWindow: { open: '10:30', close: '12:30' } });
    expect(parsed.mallWindow).toEqual({ open: '10:30', close: '12:30' });
  });

  it.each([
    ['a malformed outlet id', { id: 'OUT1' }],
    ['a non-HH:MM window time', { window: { open: '5:00', close: '07:30' } }],
    ['an unknown dock type', { dockType: 'loading_bay' }],
  ])('rejects an outlet with %s', (_label, override) => {
    expect(outletSchema.safeParse({ ...outletRow, ...override }).success).toBe(false);
  });

  it('parses a vehicle row', () => {
    expect(vehicleSchema.parse(vehicleRow)).toEqual(vehicleRow);
  });

  it('parses a depot and a calendar day', () => {
    const depot = { id: 'Peliyagoda', name: 'Peliyagoda' };
    const day = {
      date: '2026-10-07',
      dow: 2,
      isoYear: 2026,
      isoWeek: 41,
      isPayday: true,
      festival: null,
      festivalRamp: 0,
      isHoliday: false,
      monsoon: true,
      isOperating: true,
    };
    expect(depotSchema.parse(depot)).toEqual(depot);
    expect(calendarDaySchema.parse(day)).toEqual(day);
    expect(calendarDaySchema.safeParse({ ...day, festivalRamp: 1.2 }).success).toBe(false);
    expect(calendarDaySchema.safeParse({ ...day, dow: 7 }).success).toBe(false);
  });

  it.each([
    ['zero weight capacity', { weightCapKg: 0 }],
    ['a temperature used as a type', { type: 'reefer' }],
    ['a malformed vehicle id', { id: 'V1' }],
  ])('rejects a vehicle with %s', (_label, override) => {
    expect(vehicleSchema.safeParse({ ...vehicleRow, ...override }).success).toBe(false);
  });
});

describe('userSchema', () => {
  const base = { id: ids.user, name: 'Nimal Perera', email: 'nimal@example.com' };

  it('requires the scope field for each role', () => {
    expect(
      userSchema.safeParse({ ...base, role: 'store_manager', outletId: 'OUT001' }).success,
    ).toBe(true);
    expect(userSchema.safeParse({ ...base, role: 'driver', vehicleId: 'VEH014' }).success).toBe(
      true,
    );
    expect(userSchema.safeParse({ ...base, role: 'loader', depotId: 'Kandy' }).success).toBe(true);
    expect(userSchema.safeParse({ ...base, role: 'dispatcher', depotId: null }).success).toBe(true);
  });

  it.each([
    ['a store manager without an outlet', { role: 'store_manager' }],
    ['a driver without a vehicle', { role: 'driver' }],
    ['a loader without a depot', { role: 'loader' }],
    ['an unknown role', { role: 'admin', depotId: 'Kandy' }],
  ])('rejects %s', (_label, override) => {
    expect(userSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  it('strips fields that must never leave the server', () => {
    const parsed = userSchema.parse({
      ...base,
      role: 'driver',
      vehicleId: 'VEH014',
      passwordHash: '$argon2id$v=19$...',
    });
    expect(parsed).not.toHaveProperty('passwordHash');
  });
});

describe('orders, trips and deferrals', () => {
  it('parses an order', () => {
    expect(orderSchema.parse(orderRow)).toEqual(orderRow);
  });

  it.each([
    ['zero weight', { weightKg: 0 }],
    ['fractional units', { units: 1.5 }],
    ['a non-ISO requested date', { requestedDate: '02/06/2026' }],
    ['a timestamp without an offset', { submittedAt: '2026-06-01T10:15:00' }],
    ['an unknown status', { status: 'planning' }],
  ])('rejects an order with %s', (_label, override) => {
    expect(orderSchema.safeParse({ ...orderRow, ...override }).success).toBe(false);
  });

  const trip = {
    id: ids.trip,
    runId: ids.run,
    vehicleId: 'VEH014',
    tripNo: 1,
    brand: 'Fresh',
    district: 'Colombo',
    status: 'published',
    version: 1,
    plannedMinutes: 112,
    plannedKm: 36,
  };

  it('accepts trip numbers 1 and 2 only', () => {
    expect(tripSchema.safeParse(trip).success).toBe(true);
    expect(tripSchema.safeParse({ ...trip, tripNo: 2 }).success).toBe(true);
    expect(tripSchema.safeParse({ ...trip, tripNo: 3 }).success).toBe(false);
  });

  it('requires a positive stop sequence', () => {
    const stop = {
      id: ids.stop,
      tripId: ids.trip,
      orderId: ids.order,
      seq: 1,
      plannedArrival: colomboTime,
      status: 'pending',
    };
    expect(tripStopSchema.safeParse(stop).success).toBe(true);
    expect(tripStopSchema.safeParse({ ...stop, seq: 0 }).success).toBe(false);
  });

  it('never accepts a deferral without a reason code', () => {
    const deferral = {
      id: ids.other,
      orderId: ids.order,
      runId: ids.run,
      reasonCode: 'REEFER_REQUIRED',
      type: 'unavoidable',
      note: null,
      actorId: ids.user,
      createdAt: colomboTime,
    };
    expect(deferralSchema.safeParse(deferral).success).toBe(true);
    const { reasonCode: _omitted, ...withoutReason } = deferral;
    expect(deferralSchema.safeParse(withoutReason).success).toBe(false);
    expect(deferralSchema.safeParse({ ...deferral, reasonCode: 'CAPACITY' }).success).toBe(false);
  });
});

describe('loading, store and notification records', () => {
  it('requires a positive quantity on loading issues', () => {
    const issue = {
      id: ids.other,
      tripId: ids.trip,
      orderId: ids.order,
      type: 'damaged',
      qty: 2,
      note: 'Crushed carton',
      loaderId: ids.user,
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: colomboTime,
    };
    expect(loadingIssueSchema.safeParse(issue).success).toBe(true);
    expect(loadingIssueSchema.safeParse({ ...issue, qty: 0 }).success).toBe(false);
  });

  it('parses a store issue', () => {
    const issue = {
      id: ids.other,
      orderId: ids.order,
      type: 'incorrect',
      note: null,
      status: 'open',
      createdBy: ids.user,
      createdAt: colomboTime,
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
    };
    expect(issueSchema.parse(issue)).toEqual(issue);
    const resolved = {
      ...issue,
      status: 'resolved',
      resolvedBy: ids.user,
      resolvedAt: colomboTime,
      resolution: 'Credit note raised',
    };
    expect(issueSchema.parse(resolved)).toEqual(resolved);
  });
});

describe('stop events and POD', () => {
  const base = {
    clientEventId: ids.event,
    stopId: ids.stop,
    clientTime: colomboTime,
    tripVersion: 3,
  };

  it('accepts each event type with its payload', () => {
    expect(stopEventInputSchema.safeParse({ ...base, type: 'arrived', payload: {} }).success).toBe(
      true,
    );
    expect(
      stopEventInputSchema.safeParse({ ...base, type: 'delivered', payload: { podId: ids.pod } })
        .success,
    ).toBe(true);
    expect(
      stopEventInputSchema.safeParse({ ...base, type: 'failed', payload: { reason: 'Closed' } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a delivery without a POD', { type: 'delivered', payload: {} }],
    ['a failure without a reason', { type: 'failed', payload: { reason: '  ' } }],
    ['unexpected payload fields', { type: 'arrived', payload: { late: true } }],
    ['an unknown event type', { type: 'departed', payload: {} }],
  ])('rejects %s', (_label, override) => {
    expect(stopEventInputSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  it('requires a UUID client event id for idempotent sync', () => {
    const event = { ...base, clientEventId: 'evt-1', type: 'arrived', payload: {} };
    expect(stopEventInputSchema.safeParse(event).success).toBe(false);
  });

  it('adds the server id and receipt time to stored events', () => {
    const input = { ...base, type: 'arrived', payload: {} };
    expect(stopEventSchema.safeParse(input).success).toBe(false);
    const stored = { ...input, id: ids.other, serverTime: '2026-06-01T09:40:00+05:30' };
    expect(stopEventSchema.parse(stored)).toEqual(stored);
  });

  it('parses POD metadata', () => {
    const pod = {
      id: ids.pod,
      stopId: ids.stop,
      recipientName: 'K. Silva',
      hasPhoto: false,
      clientTime: colomboTime,
    };
    expect(podSchema.parse(pod)).toEqual(pod);
    expect(podSchema.safeParse({ ...pod, recipientName: '' }).success).toBe(false);
  });
});
