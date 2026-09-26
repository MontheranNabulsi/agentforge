import type { Job } from 'bullmq';
import type { WorkerRegistration } from '../../../../platform/queue/worker-host';
import type { AgentRunOrchestrator } from '../../application/agent-run-orchestrator';

/** agent-runs queue: "execute" starts (or crash-resumes) a run, "resume" continues it after an approval. */
export function agentRunWorker(
  orchestrator: AgentRunOrchestrator,
  concurrency: number,
): WorkerRegistration {
  return {
    queue: 'agent-runs',
    concurrency,
    lockDurationMs: 5 * 60_000,
    handler: async (job: Job) => {
      const data = job.data as { runId: string; approvalId?: string };
      const attempt = { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 };
      if (job.name === 'resume' && data.approvalId) {
        await orchestrator.resume(data.runId, data.approvalId, attempt);
      } else {
        await orchestrator.execute(data.runId, attempt);
      }
    },
    onFinalFailure: async (job, error) => {
      const data = job.data as { runId: string };
      await orchestrator.failAbandoned(
        data.runId,
        `The run could not be completed: ${error.message}`,
      );
    },
  };
}
