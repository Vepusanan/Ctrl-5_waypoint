import {
  addCalendarDays,
  CALENDAR_HORIZON_DAYS,
  calendarDays,
  ensureCalendarThrough,
  seedMeta,
} from '@waypoint/database';
import { and, desc, eq, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';

// SYSTEM_DESIGN §1.2 / §12.2. Cutoff and other operational decisions read this clock.
// Production follows the host clock until the demo admin endpoint pins a time.
// Callers must not read Date.now() themselves.
export interface OperatingClock {
  now(): Date;
  pin(now: Date): void;
  unpin(): void;
}

const COLOMBO_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function createOperatingClock(): OperatingClock {
  let pinned: Date | null = null;
  return {
    now() {
      return pinned === null ? new Date() : new Date(pinned.getTime());
    },
    pin(now) {
      pinned = new Date(now.getTime());
    },
    unpin() {
      pinned = null;
    },
  };
}

export const clockPlugin = fp(
  async (app, options: { demoMode?: boolean }) => {
    const clock = createOperatingClock();
    app.decorate('clock', clock);
    // Operating days are generated ahead of the operating clock, so ordering and planning never
    // reach the end of the calendar (the supplied calendar.csv stops on a fixed date). The server
    // calls this on start, on a timer and whenever the demo clock moves.
    const ensureCalendar = async () => {
      const today = new Date(clock.now().getTime() + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);
      await ensureCalendarThrough(app.db, addCalendarDays(today, CALENDAR_HORIZON_DAYS));
    };
    app.decorate('ensureCalendar', ensureCalendar);
    if (!options.demoMode) return;
    const [seed] = await app.db
      .select({ serviceDate: seedMeta.serviceDate })
      .from(seedMeta)
      .limit(1);
    if (!seed) return;
    const [previous] = await app.db
      .select({ date: calendarDays.date })
      .from(calendarDays)
      .where(and(lt(calendarDays.date, seed.serviceDate), eq(calendarDays.isOperating, true)))
      .orderBy(desc(calendarDays.date))
      .limit(1);
    // Start the demo before cutoff so seeded drafts can still be edited and submitted.
    // Session expiry continues to use real time in the auth service.
    if (previous) clock.pin(new Date(`${previous.date}T10:00:00+05:30`));
  },
  { name: 'clock', dependencies: ['db'] },
);
