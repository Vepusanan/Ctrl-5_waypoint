import type { Database } from '@waypoint/database';
import type {
  OperatingClock as OperatingClockBody,
  SeedResetRequest,
  SeedResetResponse,
  User,
} from '@waypoint/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import { ApiError } from '../../plugins/errors.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import { type AdminRepo, CLOCK_SET, createAdminRepo, DEMO_DISPATCHER_EMAIL } from './repo.ts';

// DEMO_MODE runs on the seeded day, not the host date (SYSTEM_DESIGN §12.2). The demo opens
// ten minutes before the 4 PM cutoff that closes the seeded run, so the editable seeded
// orders can still change and the dispatcher can move the clock past the cutoff on cue.
const DEMO_START_TIME = '15:50:00.000';

/**
 * Pins the operating clock where the demo left it: the time the dispatcher last moved it to, or
 * the seeded demo start when it has not moved since the seed. The pin itself lives in memory, so
 * without this a restart (a free host sleeps when idle) would put a published plan back before
 * its own cutoff. Returns null when nothing is seeded.
 */
export async function startDemoClock(
  repo: Pick<AdminRepo, 'findSeededDay' | 'lastClockMove'>,
  clock: OperatingClock,
): Promise<string | null> {
  const day = await repo.findSeededDay();
  if (day === null) return null;
  const start =
    (await repo.lastClockMove()) ?? new Date(`${day.cutoffDate}T${DEMO_START_TIME}+05:30`);
  clock.pin(start);
  return formatColomboTimestamp(start);
}

export interface DemoSeedConfig {
  password: string;
  demoDate?: string;
  dataDir?: string;
}

export interface AdminService {
  readClock(): OperatingClockBody;
  setClock(user: User | null, input: OperatingClockBody): Promise<OperatingClockBody>;
  reset(user: User | null, input: SeedResetRequest): Promise<SeedResetResponse>;
}

export function createAdminService(
  db: Database,
  audit: AuditRecorder,
  clock: OperatingClock,
  log: Pick<FastifyBaseLogger, 'info' | 'error'>,
  seed: DemoSeedConfig,
  repo = createAdminRepo(db),
): AdminService {
  return {
    readClock() {
      return { now: formatColomboTimestamp(clock.now()) };
    },

    async setClock(user, input) {
      if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
      const pinned = new Date(input.now);
      if (Number.isNaN(pinned.getTime())) {
        throw new ApiError('VALIDATION_ERROR', 'Operating time is invalid');
      }
      const before = formatColomboTimestamp(clock.now());
      const now = formatColomboTimestamp(pinned);
      // Recorded before the pin moves, so a restart always finds the move it has to restore.
      await audit.record(db, {
        actorId: user.id,
        role: user.role,
        action: CLOCK_SET,
        entityType: 'clock',
        entityId: 'operating',
        before: { now: before },
        after: { now },
        createdAt: pinned,
      });
      clock.pin(pinned);
      return { now };
    },

    async reset(user, input) {
      if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
      if (user.role !== 'dispatcher') {
        throw new ApiError('FORBIDDEN', 'You do not have access to this action');
      }
      if (input.confirm !== true) {
        throw new ApiError('VALIDATION_ERROR', 'Seed reset requires confirm: true');
      }

      let restored: Awaited<ReturnType<typeof repo.restoreSeed>>;
      try {
        restored = await repo.restoreSeed(seed);
      } catch (error) {
        log.error({ err: error }, 'seed.reset_failed');
        throw new ApiError('INTERNAL_ERROR', 'Could not restore the demo seed');
      }
      if (!restored.applied) {
        throw new ApiError('INTERNAL_ERROR', 'Could not restore the demo seed');
      }
      // A reset restores the seeded day, so the operating clock returns to its start too.
      await startDemoClock(repo, clock);

      const actor =
        (await repo.findUserByEmail(user.email)) ??
        (await repo.findUserByEmail(DEMO_DISPATCHER_EMAIL));
      if (actor === null || actor.role !== 'dispatcher') {
        throw new ApiError('INTERNAL_ERROR', 'Could not restore the demo seed');
      }

      const after = { serviceDate: restored.serviceDate, source: restored.source };
      await audit.record(db, {
        actorId: actor.id,
        role: 'dispatcher',
        action: 'seed.reset',
        entityType: 'seed',
        entityId: 'waypoint',
        after,
        createdAt: clock.now(),
      });
      log.info({ actorId: actor.id, role: 'dispatcher', ...after }, 'seed.reset');
      return after;
    },
  };
}
