import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { isAppError } from '../../shared-kernel/errors';
import type { ErrorReporter } from '../observability/error-reporter';
import type { Logger } from '../observability/logger';
import { requestContext } from '../observability/request-context';
import { QUEUE_DEFINITIONS, type QueueName, type QueueRegistry } from './queues';

export type JobHandler = (job: Job) => Promise<unknown>;

export interface WorkerRegistration {
  queue: QueueName;
  concurrency: number;
  handler: JobHandler;
  /** Called once when a job has exhausted its retries (after it is copied to the dead-letter queue). */
  onFinalFailure?: (job: Job, error: Error) => Promise<void>;
  /** Long jobs (agent runs) need a longer lock so a busy event loop isn't mistaken for a crash. */
  lockDurationMs?: number;
}

/**
 * Starts a BullMQ worker with the platform's conventions:
 * - each job runs inside a request context (jobId, queue, originating requestId) so logs correlate;
 * - validation-type AppErrors are unrecoverable (retrying cannot fix bad input);
 * - after the final attempt the job is copied to the dead-letter queue for inspection and replay.
 */
export function startWorker(
  registration: WorkerRegistration,
  deps: {
    connection: Redis;
    prefix: string;
    queues: QueueRegistry;
    logger: Logger;
    errors: ErrorReporter;
  },
): Worker {
  const { logger } = deps;
  const worker = new Worker(
    QUEUE_DEFINITIONS[registration.queue].name,
    async (job) => {
      const meta = (job.data as { meta?: { requestId?: string; traceparent?: string } }).meta;
      return requestContext.run(
        {
          jobId: job.id,
          queue: registration.queue,
          ...(meta?.requestId ? { requestId: meta.requestId } : {}),
          ...(meta?.traceparent ? { traceId: meta.traceparent } : {}),
        },
        async () => {
          const started = Date.now();
          logger.info({ job: job.name, attempt: job.attemptsMade + 1 }, 'job started');
          try {
            const result = await registration.handler(job);
            logger.info({ job: job.name, durationMs: Date.now() - started }, 'job completed');
            return result;
          } catch (error) {
            if (
              isAppError(error) &&
              ['validation', 'not_found', 'forbidden', 'unprocessable'].includes(error.kind)
            ) {
              throw new UnrecoverableError(`${error.code}: ${error.message}`);
            }
            throw error;
          }
        },
      );
    },
    {
      connection: deps.connection,
      prefix: deps.prefix,
      concurrency: registration.concurrency,
      lockDuration: registration.lockDurationMs ?? 60_000,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const final =
      job.attemptsMade >= attempts ||
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError';
    logger.warn(
      { jobId: job.id, job: job.name, attemptsMade: job.attemptsMade, final, err: error },
      'job failed',
    );
    if (!final) return;
    void (async () => {
      try {
        await deps.queues.get('dead-letter').add('dead', {
          queue: registration.queue,
          jobName: job.name,
          jobId: job.id,
          data: job.data as unknown,
          failedReason: error.message,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        });
        await registration.onFinalFailure?.(job, error);
      } catch (hookError) {
        deps.errors.capture(hookError, { where: 'dead-letter', jobId: job.id });
      }
    })();
  });
  worker.on('error', (error) =>
    logger.error({ err: error, queue: registration.queue }, 'worker error'),
  );
  return worker;
}
