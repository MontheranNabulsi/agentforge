import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobMeta, JobTopic, JobTopics } from '../../shared-kernel/jobs';

/**
 * Queue topology. One queue per kind of work so each can have its own concurrency,
 * retry policy and backlog visibility. Retries use exponential backoff:
 * delay = backoffMs * 2^(attempt - 1) (+ BullMQ jitter).
 */
export const QUEUE_DEFINITIONS = {
  email: { name: 'email', attempts: 5, backoffMs: 5_000 },
  'document-ingestion': { name: 'document-ingestion', attempts: 4, backoffMs: 5_000 },
  'agent-runs': { name: 'agent-runs', attempts: 3, backoffMs: 3_000 },
  evaluations: { name: 'evaluations', attempts: 2, backoffMs: 10_000 },
  maintenance: { name: 'maintenance', attempts: 1, backoffMs: 0 },
  'dead-letter': { name: 'dead-letter', attempts: 1, backoffMs: 0 },
} as const;

export type QueueName = keyof typeof QUEUE_DEFINITIONS;

export const WORK_QUEUES: QueueName[] = [
  'email',
  'document-ingestion',
  'agent-runs',
  'evaluations',
];

interface TopicRoute {
  queue: QueueName;
  jobName: string;
}

export const TOPIC_ROUTES: Record<JobTopic, TopicRoute> = {
  'email.send': { queue: 'email', jobName: 'send' },
  'document.ingest': { queue: 'document-ingestion', jobName: 'ingest' },
  'agent-run.execute': { queue: 'agent-runs', jobName: 'execute' },
  'agent-run.resume': { queue: 'agent-runs', jobName: 'resume' },
  'evaluation.run': { queue: 'evaluations', jobName: 'run' },
};

export type JobData<T extends JobTopic = JobTopic> = JobTopics[T] & { meta?: JobMeta };

export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly connection: Redis,
    private readonly prefix: string,
  ) {}

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      const def = QUEUE_DEFINITIONS[name];
      queue = new Queue(def.name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Adds a job for a topic. The jobId makes enqueueing idempotent (same id → one job). */
  async addForTopic(
    topic: JobTopic,
    data: Record<string, unknown>,
    options: { jobId: string; delayMs?: number },
  ): Promise<void> {
    const route = TOPIC_ROUTES[topic];
    const def = QUEUE_DEFINITIONS[route.queue];
    const jobOptions: JobsOptions = {
      jobId: options.jobId,
      attempts: def.attempts,
      backoff: def.backoffMs > 0 ? { type: 'exponential', delay: def.backoffMs } : undefined,
      removeOnComplete: { age: 24 * 3600, count: 2_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    };
    await this.get(route.queue).add(route.jobName, data, jobOptions);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** BullMQ job ids may not contain ':'; outbox keys use '-' separators. */
export const jobIdFor = (key: string) => key.replace(/:/g, '-');
