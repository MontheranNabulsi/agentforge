import pino, { type Logger } from 'pino';
import { requestContext } from './request-context';

export type { Logger };

/** Fields that must never reach a log line, wherever they appear. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'apiKey',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.authorization',
];

export function createLogger(options: {
  level: string;
  pretty: boolean;
  service: string;
  version: string;
}): Logger {
  return pino({
    level: options.level,
    base: { service: options.service, version: options.version },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = requestContext.get();
      if (!ctx) return {};
      const { requestId, userId, organizationId, projectId, runId, jobId, queue, traceId } = ctx;
      return Object.fromEntries(
        Object.entries({
          requestId,
          userId,
          organizationId,
          projectId,
          runId,
          jobId,
          queue,
          traceId,
        }).filter(([, value]) => value !== undefined),
      );
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,version',
            },
          },
        }
      : {}),
  });
}
