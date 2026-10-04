// Asia/Colombo has no daylight-saving shift, so +05:30 is the whole zone rule.
const COLOMBO_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const CUTOFF_TIME = '16:00:00.000';

/** ISO 8601 with the +05:30 offset the API contract requires. */
export function formatColomboTimestamp(instant: Date): string {
  const shifted = new Date(instant.getTime() + COLOMBO_OFFSET_MS);
  return `${shifted.toISOString().slice(0, -1)}+05:30`;
}

export function colomboDate(instant: Date): string {
  return formatColomboTimestamp(instant).slice(0, 10);
}

// BR-001. 16:00:00.000 Asia/Colombo closes the next run. Earlier instants stay open.
export function colomboCutoffReached(instant: Date): boolean {
  return formatColomboTimestamp(instant).slice(11, 23) >= CUTOFF_TIME;
}

export function cutoffInstant(previousOperatingDate: string): Date {
  return new Date(`${previousOperatingDate}T${CUTOFF_TIME}+05:30`);
}

export function isAtOrAfterCutoff(now: Date, previousOperatingDate: string): boolean {
  return now.getTime() >= cutoffInstant(previousOperatingDate).getTime();
}
