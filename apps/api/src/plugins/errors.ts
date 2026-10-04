import type { ErrorCode, Violation } from '@waypoint/shared';
import { httpStatusByErrorCode } from '@waypoint/shared';
import type { FastifyError, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly violations: readonly Violation[] | undefined;

  constructor(code: ErrorCode, message: string, violations?: readonly Violation[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.violations = violations;
  }
}

interface ErrorBody {
  code: ErrorCode;
  message: string;
  violations?: Violation[];
}

function errorBody(code: ErrorCode, message: string, violations?: readonly Violation[]): ErrorBody {
  const body: ErrorBody = { code, message };
  if (violations !== undefined && violations.length > 0) {
    body.violations = [...violations];
  }
  return body;
}

function validationMessage(error: {
  validation: readonly { instancePath: string; message?: string }[];
}): string {
  const parts = error.validation.map((issue) => {
    const field = issue.instancePath.replace(/^\//, '');
    const label = field.length > 0 ? field : 'request';
    return `${label}: ${issue.message ?? 'invalid'}`;
  });
  return parts.length > 0 ? parts.join('; ') : 'Invalid request';
}

function isRateLimited(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    error.statusCode === httpStatusByErrorCode.RATE_LIMITED
  );
}

// SYSTEM_DESIGN §6.3. Every failure uses the same envelope so clients can branch on `error.code`.
export const errorPlugin = fp(
  async (app) => {
    app.setNotFoundHandler((_request, reply) => {
      return reply
        .code(httpStatusByErrorCode.NOT_FOUND)
        .send({ error: errorBody('NOT_FOUND', 'Route not found') });
    });

    app.setErrorHandler((error: FastifyError, request, reply) => {
      const body = toErrorBody(error, request);
      const statusCode = httpStatusByErrorCode[body.code];
      if (statusCode >= 500) {
        request.log.error({ err: error }, 'request.failed');
      }
      return reply.code(statusCode).send({ error: body });
    });
  },
  { name: 'errors' },
);

function toErrorBody(error: FastifyError, request: FastifyRequest): ErrorBody {
  if (error instanceof ApiError) {
    return errorBody(error.code, error.message, error.violations);
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return errorBody('VALIDATION_ERROR', validationMessage(error));
  }
  if (isRateLimited(error)) {
    return errorBody('RATE_LIMITED', 'Too many login attempts. Try again in a minute.');
  }
  if (isResponseSerializationError(error)) {
    return errorBody('INTERNAL_ERROR', 'Something went wrong');
  }
  if (isOversizedUpload(error, request)) {
    return errorBody('VALIDATION_ERROR', 'Image must not exceed 2 MB');
  }
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
    return errorBody('VALIDATION_ERROR', 'Request body is too large');
  }
  if (isWriteCollision(error)) {
    request.log.warn({ err: error }, 'request.write_collision');
    return errorBody(
      'VERSION_CONFLICT',
      'Someone else changed this at the same time. Refresh and try again.',
    );
  }
  return errorBody('INTERNAL_ERROR', 'Something went wrong');
}

// PostgreSQL states for two writers meeting on the same rows: a unique key taken first by the
// other transaction, a serialization failure, a deadlock. The transaction rolled back whole, so
// the caller can retry on fresh data. The ORM wraps the driver error, hence the cause chain.
const WRITE_COLLISION_STATES = new Set(['23505', '40001', '40P01']);

function isWriteCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      if (WRITE_COLLISION_STATES.has(current.code)) return true;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

function isOversizedUpload(error: FastifyError, request: FastifyRequest): boolean {
  if (error.code === 'FST_REQ_FILE_TOO_LARGE') return true;
  const type = request.headers['content-type'];
  const multipart = typeof type === 'string' && type.toLowerCase().startsWith('multipart/');
  return multipart && (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413);
}
