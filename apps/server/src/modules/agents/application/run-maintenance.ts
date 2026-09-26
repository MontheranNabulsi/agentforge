import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Clock, TransactionRunner } from '../../../shared-kernel/ports';
import type { AgentRunOrchestrator } from './agent-run-orchestrator';
import type { ApprovalUseCases } from './approval-use-cases';
import type { RunRepository } from './ports';

/**
 * Periodic housekeeping the worker runs every minute:
 * - approvals past their deadline expire (and their runs resume with "expired");
 * - runs past their deadline that no worker is finishing are marked timed_out;
 * - runs stuck in "queued" (their job was lost, e.g. Redis was flushed) are re-enqueued.
 */
export class RunMaintenance {
  constructor(
    private readonly deps: {
      runs: RunRepository;
      approvals: ApprovalUseCases;
      orchestrator: AgentRunOrchestrator;
      jobs: BackgroundJobs;
      tx: TransactionRunner;
      clock: Clock;
    },
  ) {}

  async sweep(): Promise<{ expiredApprovals: number; timedOut: number; requeued: number }> {
    const { runs, approvals, orchestrator, jobs, tx, clock } = this.deps;
    const now = clock.now();
    const expiredApprovals = await approvals.expireOverdue();
    let timedOut = 0;
    let requeued = 0;
    const stale = await runs.findStale({
      queuedBefore: new Date(now.getTime() - 2 * 60_000),
      now,
      limit: 50,
    });
    for (const run of stale) {
      const graceMs = 60_000;
      if (run.deadlineAt && run.deadlineAt.getTime() + graceMs < now.getTime()) {
        if (await orchestrator.timeOut(run)) timedOut += 1;
      } else if (run.status === 'queued') {
        await tx.run(() =>
          jobs.enqueue(
            'agent-run.execute',
            { runId: run.id },
            { dedupeKey: `run-${run.id}-requeue-${now.getTime()}` },
          ),
        );
        requeued += 1;
      }
    }
    return { expiredApprovals, timedOut, requeued };
  }
}
