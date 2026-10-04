/**
 * What the data layer needs to know about the signed-in dispatcher. The workspace sets it on
 * every render; sources and fixtures read it instead of asking the API again.
 */
export const session = {
  name: 'Dispatcher',
  depotId: '',
  /** The run the workspace is showing. */
  date: '',
  /** Operating days from /calendar, ascending. */
  dates: [] as readonly string[],
  /** The demo clock's time (DEMO_MODE) and when the browser received it. */
  demoNow: null as string | null,
  demoAt: 0,
};

export function setDispatchSession(next: Partial<typeof session>) {
  Object.assign(session, next);
}

/** The operating clock as an API timestamp: the demo clock when it runs, else the device. */
export function serverNow(): string {
  const base = session.demoNow
    ? Date.parse(session.demoNow) + (Date.now() - session.demoAt)
    : Date.now();
  return new Date(base).toISOString();
}

/** The next operating day after `date`, or the calendar day after it. */
export function nextRun(date: string): string {
  const next = session.dates.find((day) => day > date);
  if (next) return next;
  const following = new Date(`${date}T12:00:00Z`);
  following.setUTCDate(following.getUTCDate() + 1);
  return following.toISOString().slice(0, 10);
}
