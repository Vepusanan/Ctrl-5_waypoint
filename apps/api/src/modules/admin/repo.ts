import {
  auditLog,
  calendarDays,
  type Database,
  DEMO_USERS,
  type SeedResult,
  seedDatabase,
  seedMeta,
  users,
} from '@waypoint/database';
import type { Role } from '@waypoint/shared';
import { and, desc, eq, lt } from 'drizzle-orm';

interface DemoActor {
  id: string;
  role: Role;
  email: string;
}

interface SeededDay {
  serviceDate: string;
  // The operating day whose 4 PM cutoff closes the seeded run.
  cutoffDate: string;
}

export interface AdminRepo {
  findUserByEmail(email: string): Promise<DemoActor | null>;
  findSeededDay(): Promise<SeededDay | null>;
  /** The operating time the dispatcher last moved the demo clock to, since the last seed. */
  lastClockMove(): Promise<Date | null>;
  restoreSeed(options: {
    password: string;
    demoDate?: string;
    dataDir?: string;
  }): Promise<SeedResult>;
}

export function createAdminRepo(db: Database): AdminRepo {
  return {
    async findUserByEmail(email) {
      const rows = await db
        .select({ id: users.id, role: users.role, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0] ?? null;
    },

    async findSeededDay() {
      const [seeded] = await db
        .select({ serviceDate: seedMeta.serviceDate })
        .from(seedMeta)
        .limit(1);
      if (seeded === undefined) return null;
      const [previous] = await db
        .select({ date: calendarDays.date })
        .from(calendarDays)
        .where(and(lt(calendarDays.date, seeded.serviceDate), eq(calendarDays.isOperating, true)))
        .orderBy(desc(calendarDays.date))
        .limit(1);
      if (previous === undefined) return null;
      return { serviceDate: seeded.serviceDate, cutoffDate: previous.date };
    },

    async lastClockMove() {
      // Audit ids are UUIDv7, so the highest id is the most recent move in real time. created_at
      // holds operating-clock time, which a move back to "before cutoff" would put out of order.
      const [move] = await db
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(eq(auditLog.action, CLOCK_SET))
        .orderBy(desc(auditLog.id))
        .limit(1);
      const now = move?.after?.now;
      if (typeof now !== 'string') return null;
      const moved = new Date(now);
      return Number.isNaN(moved.getTime()) ? null : moved;
    },

    restoreSeed(options) {
      return seedDatabase(db, {
        reset: true,
        password: options.password,
        ...(options.demoDate !== undefined ? { demoDate: options.demoDate } : {}),
        ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      });
    },
  };
}

export const CLOCK_SET = 'clock.set';
export const DEMO_DISPATCHER_EMAIL = DEMO_USERS.dispatcher.email;
