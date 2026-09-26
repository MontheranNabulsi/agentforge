import type { Worker } from 'bullmq';
import { OutboxRelay } from '../platform/queue/outbox-relay';
import { startWorker, type WorkerRegistration } from '../platform/queue/worker-host';
import { agentRunWorker } from '../modules/agents';
import { evaluationWorker } from '../modules/evaluations';
import type { Container } from './container';

/**
 * Everything that happens off the request path: the outbox relay (DB rows → BullMQ jobs),
 * one BullMQ worker per queue, and a once-a-minute maintenance sweep.
 */
export async function startWorkerRuntime(container: Container): Promise<{ stop(): Promise<void> }> {
  const {
    config,
    logger,
    errors,
    db,
    database,
    redis,
    queues,
    knowledge,
    mailer,
    agents,
    evaluations,
    idempotency,
  } = container;

  const relay = new OutboxRelay({
    db,
    pool: database.pool,
    queues,
    logger,
    pollIntervalMs: config.worker.outboxPollIntervalMs,
  });
  await relay.start();

  const registrations: WorkerRegistration[] = [
    {
      queue: 'email',
      concurrency: config.worker.concurrency.email,
      handler: async (job) => {
        const data = job.data as { to: string; subject: string; text: string; html?: string };
        await mailer.send({
          to: data.to,
          subject: data.subject,
          text: data.text,
          ...(data.html ? { html: data.html } : {}),
        });
      },
    },
    {
      queue: 'document-ingestion',
      concurrency: config.worker.concurrency.ingestion,
      lockDurationMs: 5 * 60_000,
      handler: async (job) =>
        knowledge.ingestion.ingest((job.data as { documentId: string }).documentId),
      onFinalFailure: async (job, error) =>
        knowledge.ingestion.markFailed(
          (job.data as { documentId: string }).documentId,
          error.message,
        ),
    },
    agentRunWorker(agents.orchestrator, config.worker.concurrency.agentRuns),
    evaluationWorker(evaluations, config.worker.concurrency.evaluations),
  ];
  const workers: Worker[] = registrations.map((registration) =>
    startWorker(registration, {
      connection: redis,
      prefix: config.redis.queuePrefix,
      queues,
      logger,
      errors,
    }),
  );

  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const result = await agents.maintenance.sweep();
      if (result.expiredApprovals || result.timedOut || result.requeued)
        logger.info(result, 'maintenance sweep');
      await idempotency.purgeExpired();
    } catch (error) {
      errors.capture(error, { where: 'maintenance' });
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref();
  void sweep();

  logger.info({ queues: registrations.map((r) => r.queue) }, 'worker runtime started');
  return {
    stop: async () => {
      clearInterval(timer);
      await relay.stop();
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
