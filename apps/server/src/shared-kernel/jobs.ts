/**
 * Background work is requested by *topic*. Application code writes a topic + payload to the
 * transactional outbox (port below); the worker's outbox relay turns rows into BullMQ jobs.
 * Topics and their payloads are the contract between the modules that request work and the
 * job handlers that perform it.
 */
export interface JobTopics {
  'email.send': { to: string; subject: string; text: string; html?: string };
  'document.ingest': { documentId: string };
  'agent-run.execute': { runId: string };
  'agent-run.resume': { runId: string; approvalId: string };
  'evaluation.run': { evaluationRunId: string };
}

export type JobTopic = keyof JobTopics;

/** Correlation carried from the request that asked for the work to the job that does it. */
export interface JobMeta {
  requestId?: string;
  traceparent?: string;
}

export interface EnqueueOptions {
  /** Becomes the BullMQ job id: enqueueing the same key twice yields one job. */
  dedupeKey?: string;
  delayMs?: number;
}

export interface BackgroundJobs {
  /** Records the request inside the current transaction; nothing is queued if it rolls back. */
  enqueue<T extends JobTopic>(
    topic: T,
    payload: JobTopics[T],
    options?: EnqueueOptions,
  ): Promise<void>;
}
