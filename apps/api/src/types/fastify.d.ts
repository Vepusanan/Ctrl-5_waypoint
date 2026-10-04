import type { Database } from '@waypoint/database';
import type { Role, User } from '@waypoint/shared';
import type { preHandlerHookHandler } from 'fastify';
import type { AuthService } from '../modules/auth/service.ts';
import type { AuditRecorder } from '../plugins/audit.ts';
import type { OperatingClock } from '../plugins/clock.ts';
import type { DomainEventBus } from '../plugins/domain-events.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    audit: AuditRecorder;
    clock: OperatingClock;
    /** Generates operating days ahead of the operating clock. */
    ensureCalendar: () => Promise<void>;
    domainEvents: DomainEventBus;
    authService: AuthService;
    secureCookies: boolean;
    requireRole: (...roles: [Role, ...Role[]]) => preHandlerHookHandler;
  }

  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}
