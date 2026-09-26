import type { Logger } from './logger';
import { requestContext } from './request-context';

/**
 * Where unexpected errors go. The default implementation writes a structured log line with
 * the correlation ids; swapping in Sentry or similar means implementing this interface
 * (a documented exercise), not touching call sites.
 */
export interface ErrorReporter {
  capture(error: unknown, context?: Record<string, unknown>): void;
}

export class LogErrorReporter implements ErrorReporter {
  constructor(private readonly logger: Logger) {}

  capture(error: unknown, context: Record<string, unknown> = {}): void {
    this.logger.error(
      { err: error, ...context, context: requestContext.get() },
      'unexpected error',
    );
  }
}
