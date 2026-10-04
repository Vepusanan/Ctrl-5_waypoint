import { describe, expect, it } from 'vitest';
import { loadEnv, secureSessionCookies } from '../src/config/env.ts';

const validEnv = {
  DATABASE_URL: 'postgres://waypoint:secret@localhost:5432/waypoint',
  SESSION_SECRET: 'x'.repeat(64),
};

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    expect(loadEnv(validEnv)).toEqual({
      ...validEnv,
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DEMO_MODE: false,
    });
  });

  it('coerces PORT and DEMO_MODE from strings', () => {
    const env = loadEnv({ ...validEnv, PORT: '8080', DEMO_MODE: 'true', DEMO_DATE: '2026-06-01' });
    expect(env).toMatchObject({ PORT: 8080, DEMO_MODE: true, DEMO_DATE: '2026-06-01' });
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnv({ SESSION_SECRET: validEnv.SESSION_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/waypoint' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a short SESSION_SECRET', () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the .env.example session secret outside DEMO_MODE', () => {
    const placeholder = 'change-me-to-64-random-characters-before-any-shared-deploy';
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: placeholder })).toThrow(/placeholder/);
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: placeholder, DEMO_MODE: 'false' })).toThrow(
      /placeholder/,
    );
    // A local demo started from the example file still boots.
    expect(loadEnv({ ...validEnv, SESSION_SECRET: placeholder, DEMO_MODE: 'true' }).DEMO_MODE).toBe(
      true,
    );
  });

  it('rejects a malformed DEMO_DATE', () => {
    expect(() => loadEnv({ ...validEnv, DEMO_DATE: '03/10/2026' })).toThrow(/DEMO_DATE/);
  });
});

describe('session cookie deployment configuration', () => {
  it('accepts explicit local HTTP while retaining Secure on production HTTPS', () => {
    expect(secureSessionCookies({ DOMAIN: 'http://localhost' }, true)).toBe(false);
    expect(secureSessionCookies({ DOMAIN: 'http://127.0.0.1:8080' }, true)).toBe(false);
    expect(secureSessionCookies({ DOMAIN: 'waypoint.example.com' }, true)).toBe(true);
    expect(secureSessionCookies({ DOMAIN: 'http://localhost.example.com' }, true)).toBe(true);
    expect(secureSessionCookies({}, true)).toBe(true);
    expect(secureSessionCookies({}, false)).toBe(false);
    expect(secureSessionCookies({ SECURE_COOKIES: true, DOMAIN: 'http://localhost' }, true)).toBe(
      true,
    );
  });
});
