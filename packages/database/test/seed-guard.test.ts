import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED_PASSWORD } from '../src/seed/constants.ts';
import { assertSeedPermitted, loadSeedEnv } from '../src/seed/env.ts';

describe('seed command guard', () => {
  it('reads DEMO_MODE as off unless it is set', () => {
    expect(loadSeedEnv({}).demoMode).toBe(false);
    expect(loadSeedEnv({ DEMO_MODE: '' }).demoMode).toBe(false);
    expect(loadSeedEnv({ DEMO_MODE: 'false' }).demoMode).toBe(false);
    expect(loadSeedEnv({ DEMO_MODE: 'true' }).demoMode).toBe(true);
  });

  it('allows a seed and a reset in DEMO_MODE, with the demo password', () => {
    const env = loadSeedEnv({ DEMO_MODE: 'true' });
    expect(env.password).toBe(DEFAULT_SEED_PASSWORD);
    expect(() => assertSeedPermitted(env, { reset: false })).not.toThrow();
    expect(() => assertSeedPermitted(env, { reset: true })).not.toThrow();
  });

  it('never resets a database outside DEMO_MODE', () => {
    const env = loadSeedEnv({ DEMO_MODE: 'false', SEED_PASSWORD: 'a-real-secret-value' });
    expect(() => assertSeedPermitted(env, { reset: true })).toThrow(/DEMO_MODE=true/);
    expect(() => assertSeedPermitted(loadSeedEnv({}), { reset: true })).toThrow(
      /Refusing to reset/,
    );
  });

  it('refuses the published demo password outside DEMO_MODE', () => {
    expect(() => assertSeedPermitted(loadSeedEnv({}), { reset: false })).toThrow(/SEED_PASSWORD/);
    const own = loadSeedEnv({ SEED_PASSWORD: 'a-real-secret-value' });
    expect(() => assertSeedPermitted(own, { reset: false })).not.toThrow();
  });
});
