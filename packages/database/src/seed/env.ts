import { z } from 'zod';
import { DEFAULT_SEED_PASSWORD } from './constants.ts';

const seedEnvSchema = z.object({
  DATA_DIR: z.string().min(1).optional(),
  DEMO_DATE: z.iso.date().optional(),
  SEED_PASSWORD: z.string().min(8, 'SEED_PASSWORD must be at least 8 characters').optional(),
  DEMO_MODE: z.stringbool().default(false),
});

export interface SeedEnv {
  dataDir: string | undefined;
  demoDate: string | undefined;
  password: string;
  demoMode: boolean;
}

export function loadSeedEnv(source: NodeJS.ProcessEnv): SeedEnv {
  const result = seedEnvSchema.safeParse({
    DATA_DIR: blankToUndefined(source.DATA_DIR),
    DEMO_DATE: blankToUndefined(source.DEMO_DATE),
    SEED_PASSWORD: blankToUndefined(source.SEED_PASSWORD),
    DEMO_MODE: blankToUndefined(source.DEMO_MODE),
  });
  if (!result.success) {
    throw new Error(`Invalid seed environment:\n${z.prettifyError(result.error)}`);
  }
  return {
    dataDir: result.data.DATA_DIR,
    demoDate: result.data.DEMO_DATE,
    password: result.data.SEED_PASSWORD ?? DEFAULT_SEED_PASSWORD,
    demoMode: result.data.DEMO_MODE,
  };
}

/**
 * What the seed command may do outside DEMO_MODE. A reset truncates every operational table, so
 * it never runs against a database that is not a demo. A first seed there still loads the master
 * data, but not with the published demo password.
 */
export function assertSeedPermitted(
  env: Pick<SeedEnv, 'demoMode' | 'password'>,
  options: { reset: boolean },
): void {
  if (env.demoMode) return;
  if (options.reset) {
    throw new Error(
      'Refusing to reset: --reset deletes every order, trip, delivery and audit record. It only runs with DEMO_MODE=true.',
    );
  }
  if (env.password === DEFAULT_SEED_PASSWORD) {
    throw new Error(
      'Refusing to seed accounts with the default demo password outside DEMO_MODE. Set SEED_PASSWORD.',
    );
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}
