/**
 * Application errors carry a *kind* (how the edge should respond) and a stable *code*
 * (what exactly went wrong). The HTTP layer maps kinds to status codes; nothing below
 * the presentation layer knows about HTTP.
 */
export type ErrorKind =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'unprocessable'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly fieldErrors: FieldError[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    kind: ErrorKind,
    code: string,
    message: string,
    options: {
      fieldErrors?: FieldError[];
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.details = options.details;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

export const validationError = (code: string, message: string, fieldErrors?: FieldError[]) =>
  new AppError('validation', code, message, fieldErrors ? { fieldErrors } : {});

export const unauthenticated = (message = 'Sign in to continue') =>
  new AppError('unauthenticated', 'UNAUTHENTICATED', message);

export const forbidden = (code: string, message: string) =>
  new AppError('forbidden', code, message);

export const notFound = (code: string, message = 'Not found') =>
  new AppError('not_found', code, message);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', code, message, details ? { details } : {});

export const preconditionFailed = (code: string, message: string) =>
  new AppError('precondition_failed', code, message);

export const unprocessable = (code: string, message: string) =>
  new AppError('unprocessable', code, message);

export const rateLimited = (code: string, message: string) =>
  new AppError('rate_limited', code, message);

export const unavailable = (code: string, message: string, cause?: unknown) =>
  new AppError('unavailable', code, message, { cause });
