import type { Database } from '@waypoint/database';
import type { Role, User } from '@waypoint/shared';
import type { preValidationHookHandler } from 'fastify';
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
    /** Runs before request validation, so a caller without access learns nothing of the schema. */
    requireRole: (...roles: [Role, ...Role[]]) => preValidationHookHandler;
  }

  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}
