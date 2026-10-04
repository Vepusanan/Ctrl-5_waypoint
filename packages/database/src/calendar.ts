import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { calendarDays } from './schema/index.ts';
import type { CalendarDayRecord } from './seed/types.ts';

// The supplied calendar.csv ends on a fixed date. Operating days after it follow the rules the
// file itself shows: Monday to Saturday, payday on the 25th and the last day of the month, and
// the two monsoon seasons. Festivals and public holidays are not known in advance, so generated
// days carry none; a later calendar import can overwrite them.
const DAY_MS = 86_400_000;
const MONSOON_MONTHS = new Set([3, 4, 5, 6, 10, 11]);
/** How far past "today" the calendar is kept, so ordering and planning never run out of days. */
export const CALENDAR_HORIZON_DAYS = 120;

const utc = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function addCalendarDays(isoDate: string, days: number): string {
  return iso(new Date(utc(isoDate).getTime() + days * DAY_MS));
}

function isoWeek(date: Date): { isoYear: number; isoWeek: number } {
  // ISO 8601: the week belongs to the year that holds its Thursday.
  const thursday = new Date(date.getTime());
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return { isoYear: thursday.getUTCFullYear(), isoWeek: week };
}

export function generatedCalendarDay(isoDate: string): CalendarDayRecord {
  const date = utc(isoDate);
  // calendar.csv numbers Monday as 0.
  const dow = (date.getUTCDay() + 6) % 7;
  const lastOfMonth = new Date(date.getTime() + DAY_MS).getUTCDate() === 1;
  return {
    date: isoDate,
    dow,
    ...isoWeek(date),
    isPayday: date.getUTCDate() === 25 || lastOfMonth,
    festival: null,
    festivalRamp: 0,
    isHoliday: false,
    monsoon: MONSOON_MONTHS.has(date.getUTCMonth() + 1),
    isOperating: dow !== 6,
  };
}

/** Days after `afterDate` up to and including `throughDate`. Empty when nothing is missing. */
export function generateCalendarDays(afterDate: string, throughDate: string): CalendarDayRecord[] {
  const days: CalendarDayRecord[] = [];
  for (
    let date = addCalendarDays(afterDate, 1);
    date <= throughDate;
    date = addCalendarDays(date, 1)
  ) {
    days.push(generatedCalendarDay(date));
  }
  return days;
}

/** Extends a loaded calendar in memory so a demo day near or past its end still has a next run. */
export function withCalendarHorizon(
  calendar: CalendarDayRecord[],
  throughDate: string,
): CalendarDayRecord[] {
  const last = calendar.reduce((latest, day) => (day.date > latest ? day.date : latest), '');
  if (last === '' || last >= throughDate) return calendar;
  return [...calendar, ...generateCalendarDays(last, throughDate)];
}

/**
 * Makes sure calendar_days reaches `throughDate`. Safe to call often and from several processes:
 * existing rows are left alone.
 */
export async function ensureCalendarThrough(db: Database, throughDate: string): Promise<number> {
  const rows = await db
    .select({ last: sql<string | null>`max(${calendarDays.date})` })
    .from(calendarDays);
  const last = rows[0]?.last ?? null;
  // An unseeded database has no calendar to extend.
  if (last === null || last >= throughDate) return 0;
  const days = generateCalendarDays(last, throughDate);
  for (let start = 0; start < days.length; start += 500) {
    await db
      .insert(calendarDays)
      .values(days.slice(start, start + 500))
      .onConflictDoNothing();
  }
  return days.length;
}
