import type { Job } from 'bullmq';
import type { WorkerRegistration } from '../../../../platform/queue/worker-host';
import type { EvaluationUseCases } from '../../application/evaluation-use-cases';

/** evaluations queue: one job runs a whole dataset; results are saved case by case, so a retry resumes. */
export function evaluationWorker(
  evaluations: EvaluationUseCases,
  concurrency: number,
): WorkerRegistration {
  return {
    queue: 'evaluations',
    concurrency,
    lockDurationMs: 10 * 60_000,
    handler: async (job: Job) => {
      await evaluations.execute((job.data as { evaluationRunId: string }).evaluationRunId);
    },
  };
}
