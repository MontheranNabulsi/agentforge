import type { FastifyError, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import type { ProblemDetails } from '@agentforge/contracts';
import { isAppError, type ErrorKind } from '../../shared-kernel/errors';

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  unprocessable: 422,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Unprocessable content',
  429: 'Too many requests',
  500: 'Internal server error',
  503: 'Service unavailable',
};

export function problem(
  status: number,
  code: string,
  detail: string | undefined,
  request?: FastifyRequest,
  errors?: ProblemDetails['errors'],
): ProblemDetails {
  return {
    type: `https://agentforge.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(request ? { instance: request.url.split('?')[0], requestId: String(request.id) } : {}),
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

/** Maps any thrown value to RFC 9457 problem details. */
export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  if (isAppError(error)) {
    const status = STATUS_BY_KIND[error.kind];
    return problem(status, error.code, error.message, request, error.fieldErrors);
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors = error.validation.map((issue) => ({
      path: `${error.validationContext ?? 'body'}${issue.instancePath ? issue.instancePath.replace(/\//g, '.') : ''}`,
      message: issue.message ?? 'Invalid value',
    }));
    return problem(400, 'VALIDATION_FAILED', 'The request is invalid', request, errors);
  }
  if (isResponseSerializationError(error)) {
    return problem(
      500,
      'RESPONSE_SERIALIZATION_FAILED',
      'The server produced an invalid response',
      request,
    );
  }
  const fastifyError = error as Partial<FastifyError>;
  if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
    const code = fastifyError.code ?? 'BAD_REQUEST';
    return problem(
      fastifyError.statusCode,
      code.replace(/^FST_/, ''),
      fastifyError.message,
      request,
    );
  }
  return problem(500, 'INTERNAL_ERROR', 'Something went wrong on our side', request);
}
