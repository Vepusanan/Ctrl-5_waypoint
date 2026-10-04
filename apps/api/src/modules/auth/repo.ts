import type { Database } from '@waypoint/database';
import { sessions, users } from '@waypoint/database';
import type { Role } from '@waypoint/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AuditRecorder } from '../../plugins/audit.ts';
import { ApiError } from '../../plugins/errors.ts';
import { SESSION_TTL_MS } from './cookies.ts';

type UserRow = typeof users.$inferSelect;

export interface ActiveSession {
  sessionId: string;
  user: UserRow;
}

export function createAuthRepo(db: Database) {
  return {
    async findUserByEmail(email: string): Promise<UserRow | null> {
      const rows = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveSession(sessionId: string, now: Date): Promise<ActiveSession | null> {
      const rows = await db
        .select({ sessionId: sessions.id, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        // A deactivated account loses its open sessions on the next request.
        .where(
          and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now), isNull(users.disabledAt)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async deleteExpiredSession(sessionId: string, now: Date): Promise<void> {
      await db
        .delete(sessions)
        .where(and(eq(sessions.id, sessionId), sql`${sessions.expiresAt} <= ${now}`));
    },

    async touchSession(sessionId: string, now: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
        .where(eq(sessions.id, sessionId));
    },

    async openSession(
      user: UserRow,
      now: Date,
      audit: AuditRecorder,
    ): Promise<{ sessionId: string; expiresAt: Date }> {
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(sessions)
          .values({ userId: user.id, expiresAt })
          .returning({ id: sessions.id });
        const session = inserted[0];
        if (session === undefined) {
          throw new ApiError('INTERNAL_ERROR', 'Could not create a session');
        }
        await audit.record(tx, {
          actorId: user.id,
          role: user.role,
          action: 'auth.login',
          entityType: 'session',
          entityId: session.id,
          after: { expiresAt: expiresAt.toISOString() },
        });
        return { sessionId: session.id, expiresAt };
      });
    },

    async closeSession(
      sessionId: string,
      actor: { id: string; role: Role },
      audit: AuditRecorder,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await audit.record(tx, {
          actorId: actor.id,
          role: actor.role,
          action: 'auth.logout',
          entityType: 'session',
          entityId: sessionId,
        });
        await tx.delete(sessions).where(eq(sessions.id, sessionId));
      });
    },
  };
}
