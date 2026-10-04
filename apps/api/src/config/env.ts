import { databaseUrlSchema } from '@waypoint/database';
import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: databaseUrlSchema,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SECURE_COOKIES: z.stringbool().optional(),
  DOMAIN: z.string().optional(),
  DEMO_MODE: z.stringbool().default(false),
  DEMO_DATE: z.iso.date().optional(),
  // Sign-in attempts allowed per address per minute. A shared demo, where one reviewer
  // switches between several accounts, may need more than the default of 10.
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000).optional(),
});

export function loadEnv(source: NodeJS.ProcessEnv): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function secureSessionCookies(
  env: { SECURE_COOKIES?: boolean | undefined; DOMAIN?: string | undefined },
  production: boolean,
): boolean {
  return (
    env.SECURE_COOKIES ??
    (production && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(env.DOMAIN ?? ''))
  );
}
