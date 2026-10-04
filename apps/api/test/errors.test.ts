import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPlugin } from '../src/plugins/errors.ts';

function databaseError(state: string): Error {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
    code: state,
  });
  // The ORM wraps the driver error and puts the SQL text in its own message.
  return new Error('Failed query: insert into "trip_stops" ...', { cause: driver });
}

describe('error envelope', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(errorPlugin);
    app.get('/unique', () => {
      throw databaseError('23505');
    });
    app.get('/deadlock', () => {
      throw databaseError('40P01');
    });
    app.get('/foreign-key', () => {
      throw databaseError('23503');
    });
    app.get('/crash', () => {
      throw new Error('select secret from users');
    });
    await app.ready();
  });

  afterAll(() => app.close());

  it('reports two writers meeting on the same rows as a conflict to retry', async () => {
    for (const url of ['/unique', '/deadlock']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Someone else changed this at the same time. Refresh and try again.',
        },
      });
    }
  });

  it('never returns SQL or driver text for an unexpected failure', async () => {
    for (const url of ['/foreign-key', '/crash']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      });
      expect(response.body).not.toMatch(/select|insert|constraint/i);
    }
  });
});
