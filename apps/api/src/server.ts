import { createDatabase, loadSeedEnv } from '@waypoint/database';
import { buildApp } from './app.ts';
import { loadEnv, secureSessionCookies } from './config/env.ts';
import { createAdminRepo } from './modules/admin/repo.ts';
import { startDemoClock } from './modules/admin/service.ts';

const env = loadEnv(process.env);
const seedEnv = env.DEMO_MODE ? loadSeedEnv(process.env) : undefined;

const connection = createDatabase(env.DATABASE_URL, {
  onPoolError: (error) => app.log.error({ err: error }, 'db.pool_error'),
});
const app = await buildApp({
  db: connection.db,
  logger: { level: env.LOG_LEVEL },
  sessionSecret: env.SESSION_SECRET,
  secureCookies: secureSessionCookies(env, process.env.NODE_ENV === 'production'),
  demoMode: env.DEMO_MODE,
  ...(env.LOGIN_RATE_LIMIT !== undefined ? { loginLimit: env.LOGIN_RATE_LIMIT } : {}),
  ...(seedEnv === undefined
    ? {}
    : {
        seed: {
          password: seedEnv.password,
          ...(seedEnv.demoDate !== undefined ? { demoDate: seedEnv.demoDate } : {}),
          ...(seedEnv.dataDir !== undefined ? { dataDir: seedEnv.dataDir } : {}),
        },
      }),
});
app.addHook('onClose', () => connection.close());

// The pin lives in memory, so every start re-derives it from the seeded day.
if (env.DEMO_MODE) {
  const start = await startDemoClock(createAdminRepo(connection.db), app.clock);
  if (start === null) app.log.warn('demo_clock.unseeded');
  else app.log.info({ now: start }, 'demo_clock.pinned');
}

// Keep operating days generated ahead of the clock. A failure here must not stop the API: the
// calendar already covers the horizon from the last run.
const CALENDAR_CHECK_MS = 6 * 60 * 60 * 1000;
const extendCalendar = () =>
  app.ensureCalendar().catch((error: unknown) => {
    app.log.error({ err: error }, 'calendar.extend_failed');
  });
await extendCalendar();
const calendarTimer = setInterval(extendCalendar, CALENDAR_CHECK_MS);
calendarTimer.unref();
app.addHook('onClose', async () => clearInterval(calendarTimer));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown_failed');
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
