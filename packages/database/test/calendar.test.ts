import { describe, expect, it } from 'vitest';
import {
  generateCalendarDays,
  generatedCalendarDay,
  withCalendarHorizon,
} from '../src/calendar.ts';

describe('generated calendar days', () => {
  it('follows the operating rules of the supplied calendar', () => {
    // 2026-06-28 is a Sunday; calendar.csv numbers Monday as 0.
    expect(generatedCalendarDay('2026-06-28')).toMatchObject({ dow: 6, isOperating: false });
    expect(generatedCalendarDay('2026-06-29')).toMatchObject({
      dow: 0,
      isOperating: true,
      isoYear: 2026,
      isoWeek: 27,
      festival: null,
      isHoliday: false,
    });
    expect(generatedCalendarDay('2026-07-25').isPayday).toBe(true);
    expect(generatedCalendarDay('2026-07-31').isPayday).toBe(true);
    expect(generatedCalendarDay('2026-07-30').isPayday).toBe(false);
    expect(generatedCalendarDay('2027-02-28').isPayday).toBe(true);
    expect(generatedCalendarDay('2026-10-10').monsoon).toBe(true);
    expect(generatedCalendarDay('2026-08-10').monsoon).toBe(false);
  });

  it('numbers ISO weeks across a year boundary', () => {
    expect(generatedCalendarDay('2026-12-31')).toMatchObject({ isoYear: 2026, isoWeek: 53 });
    expect(generatedCalendarDay('2027-01-03')).toMatchObject({ isoYear: 2026, isoWeek: 53 });
    expect(generatedCalendarDay('2027-01-04')).toMatchObject({ isoYear: 2027, isoWeek: 1 });
    expect(generatedCalendarDay('2024-12-30')).toMatchObject({ isoYear: 2025, isoWeek: 1 });
  });

  it('generates every day after the last one, with no gaps or repeats', () => {
    const days = generateCalendarDays('2026-06-28', '2026-07-12');
    expect(days.map((day) => day.date)).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ]);
    expect(days.filter((day) => !day.isOperating).map((day) => day.date)).toEqual([
      '2026-07-05',
      '2026-07-12',
    ]);
    expect(generateCalendarDays('2026-07-12', '2026-07-12')).toEqual([]);
  });

  it('extends a loaded calendar only past its end', () => {
    const loaded = [generatedCalendarDay('2026-06-27'), generatedCalendarDay('2026-06-28')];
    expect(withCalendarHorizon(loaded, '2026-06-28')).toBe(loaded);
    const extended = withCalendarHorizon(loaded, '2026-07-01');
    expect(extended.map((day) => day.date)).toEqual([
      '2026-06-27',
      '2026-06-28',
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
    ]);
  });
});
