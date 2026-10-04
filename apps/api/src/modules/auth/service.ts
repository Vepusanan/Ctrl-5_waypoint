import type { Database, users } from '@waypoint/database';
import type { LoginRequest, User } from '@waypoint/shared';
import { userSchema } from '@waypoint/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../../plugins/audit.ts';
import { ApiError } from '../../plugins/errors.ts';
import { passwordMatches } from './password.ts';
import { createAuthRepo } from './repo.ts';

type UserRow = typeof users.$inferSelect;

interface SessionPrincipal {
  user: User;
  sessionId: string;
}

export interface AuthService {
  login(input: LoginRequest, now?: Date): Promise<SessionPrincipal>;
  logout(user: User | null, sessionId: string | null): Promise<void>;
  load(sessionId: string, now?: Date): Promise<SessionPrincipal | null>;
  touch(sessionId: string, now?: Date): Promise<void>;
}

function userCandidate(row: UserRow): unknown {
  const base = { id: row.id, name: row.name, email: row.email, role: row.role };
  if (row.role === 'driver') return { ...base, vehicleId: row.vehicleId };
  if (row.role === 'store_manager') return { ...base, outletId: row.outletId };
  return { ...base, depotId: row.depotId };
}

function publicUser(row: UserRow): User {
  const parsed = userSchema.safeParse(userCandidate(row));
  if (!parsed.success) {
    throw new ApiError('INTERNAL_ERROR', 'Stored user is invalid');
  }
  return parsed.data;
}

export function createAuthService(
  db: Database,
  audit: AuditRecorder,
  log: Pick<FastifyBaseLogger, 'warn'>,
): AuthService {
  const repo = createAuthRepo(db);

  return {
    async login(input, now = new Date()) {
      const email = input.email.trim().toLowerCase();
      const row = await repo.findUserByEmail(email);
      const matches = await passwordMatches(input.password, row?.passwordHash ?? null);
      // A deactivated account gets the same answer as a wrong password.
      if (row === null || !matches || row.disabledAt !== null) {
        log.warn({ email }, 'auth.login_failed');
        throw new ApiError('UNAUTHENTICATED', 'Invalid email or password');
      }
      const opened = await repo.openSession(row, now, audit);
      return { user: publicUser(row), sessionId: opened.sessionId };
    },

    async logout(user, sessionId) {
      if (user === null || sessionId === null) return;
      await repo.closeSession(sessionId, { id: user.id, role: user.role }, audit);
    },

    async load(sessionId, now = new Date()) {
      const active = await repo.findActiveSession(sessionId, now);
      if (active === null) {
        await repo.deleteExpiredSession(sessionId, now);
        return null;
      }
      return { user: publicUser(active.user), sessionId: active.sessionId };
    },

    async touch(sessionId, now = new Date()) {
      await repo.touchSession(sessionId, now);
    },
  };
}
