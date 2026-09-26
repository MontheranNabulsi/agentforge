import type { RunError, RunOutput } from '@agentforge/contracts';
import { LlmError } from '../../../shared-kernel/ai';
import type { Clock, TransactionRunner } from '../../../shared-kernel/ports';
import type { AuditLog } from '../../audit';
import { ACTIVE_STATUSES, isTerminal, RunStopped } from '../domain/run-rules';
import type {
  AgentRepository,
  AgentWorkflow,
  ApprovalRepository,
  ApprovalResume,
  RunCompletionHandlers,
  RunEventPublisher,
  RunRecord,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  WorkflowOutcome,
} from './ports';
import type { RunContext } from './run-context';
import type { RunContextFactory } from './run-context-factory';
import { toRunError } from './run-nodes';

export interface OrchestratorLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OrchestratorDeps {
  agents: AgentRepository;
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  approvals: ApprovalRepository;
  workflow: AgentWorkflow<RunContext>;
  contexts: RunContextFactory;
  completionHandlers: RunCompletionHandlers;
  events: RunEventPublisher;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
  logger: OrchestratorLogger;
}

export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

/**
 * Drives runs through their lifecycle: queued → running → (awaiting_approval → running)* → terminal.
 *
 * Every transition is a conditional UPDATE (from-status → to-status), so two workers, a retry
 * and a cancel can race without corrupting a run: whoever loses the race sees "not applied"
 * and backs off. The graph itself is checkpointed after every node, so a crashed worker's
 * retry continues from the last finished node instead of starting over.
 */
export class AgentRunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Job handler for agent-run.execute (also used inline by evaluations). */
  async execute(
    runId: string,
    attempt: AttemptInfo = { attempt: 1, maxAttempts: 1 },
  ): Promise<void> {
    const { runs, clock } = this.deps;
    const run = await runs.findById(runId);
    if (!run || isTerminal(run.status) || run.status === 'awaiting_approval') return;
    if (run.cancelRequestedAt) {
      await this.finish(run, 'cancelled', null, {
        code: 'CANCELLED',
        message: 'The run was cancelled',
        retryable: false,
      });
      return;
    }
    const now = clock.now();
    const handle = await this.deps.contexts.create(
      run,
      run.deadlineAt ?? new Date(now.getTime() + (await this.timeoutMs(run))),
    );
    try {
      const applied = await runs.transition(
        run.id,
        ['queued', 'running'],
        'running',
        { startedAt: run.startedAt ?? now, deadlineAt: handle.ctx.deadlineAt },
        now,
      );
      if (!applied) return;
      await handle.ctx.emit({
        type: 'run.status',
        runId: run.id,
        status: 'running',
        at: now.toISOString(),
      });
      const outcome = await this.deps.workflow.start(handle.ctx);
      await this.handleOutcome(handle.ctx, outcome);
    } catch (error) {
      await this.handleError(handle.ctx, error, attempt);
    } finally {
      handle.dispose();
    }
  }

  /** Job handler for agent-run.resume: a person decided on an approval. */
  async resume(
    runId: string,
    approvalId: string,
    attempt: AttemptInfo = { attempt: 1, maxAttempts: 1 },
  ): Promise<void> {
    const { runs, approvals, clock } = this.deps;
    const run = await runs.findById(runId);
    if (!run || isTerminal(run.status)) return;
    const approval = await approvals.findById(approvalId);
    if (!approval || approval.runId !== runId || approval.status === 'pending') return;
    if (run.cancelRequestedAt) {
      await this.finish(run, 'cancelled', null, {
        code: 'CANCELLED',
        message: 'The run was cancelled',
        retryable: false,
      });
      return;
    }
    const decision: ApprovalResume = {
      approvalId,
      toolCallId: approval.toolCallId,
      decision:
        approval.status === 'approved'
          ? 'approved'
          : approval.status === 'expired'
            ? 'expired'
            : 'rejected',
      comment: approval.decisionComment,
    };
    const now = clock.now();
    // Time spent waiting for a person does not count against the run: the clock restarts on resume.
    const deadlineAt = new Date(now.getTime() + (await this.timeoutMs(run)));
    const handle = await this.deps.contexts.create(run, deadlineAt);
    try {
      const applied = await runs.transition(
        run.id,
        ['awaiting_approval', 'running'],
        'running',
        { deadlineAt },
        now,
      );
      if (!applied) return;
      await handle.ctx.emit({
        type: 'run.status',
        runId: run.id,
        status: 'running',
        at: now.toISOString(),
      });
      const outcome = await this.deps.workflow.resume(handle.ctx, decision);
      await this.handleOutcome(handle.ctx, outcome);
    } catch (error) {
      await this.handleError(handle.ctx, error, attempt);
    } finally {
      handle.dispose();
    }
  }

  /** Called when the job system gives up on a run (retries exhausted or the worker died). */
  async failAbandoned(runId: string, reason: string): Promise<void> {
    const run = await this.deps.runs.findById(runId);
    if (!run || isTerminal(run.status)) return;
    await this.finish(run, 'failed', null, { code: 'INTERNAL', message: reason, retryable: false });
  }

  /** Cancels a run that is not currently executing (queued or waiting for approval). */
  async cancelIdle(run: RunRecord): Promise<boolean> {
    if (run.status !== 'queued' && run.status !== 'awaiting_approval') return false;
    return this.finish(run, 'cancelled', null, {
      code: 'CANCELLED',
      message: 'The run was cancelled',
      retryable: false,
    });
  }

  /** Marks a run that outlived its deadline (maintenance sweep). */
  async timeOut(run: RunRecord): Promise<boolean> {
    return this.finish(run, 'timed_out', null, {
      code: 'DEADLINE_EXCEEDED',
      message: 'The run exceeded its time limit',
      retryable: false,
    });
  }

  private async timeoutMs(run: RunRecord): Promise<number> {
    const version = await this.deps.agents.findVersion(run.agentVersionId);
    return (version?.limits.timeoutSeconds ?? 180) * 1000;
  }

  private async handleOutcome(ctx: RunContext, outcome: WorkflowOutcome): Promise<void> {
    const { runs, clock } = this.deps;
    if (outcome.kind === 'interrupted') {
      const now = clock.now();
      const applied = await runs.transition(ctx.run.id, ['running'], 'awaiting_approval', {}, now);
      if (applied)
        await ctx.emit({
          type: 'run.status',
          runId: ctx.run.id,
          status: 'awaiting_approval',
          at: now.toISOString(),
        });
      // A cancel that arrived while the run was executing only set the flag; honour it now.
      const latest = await runs.findById(ctx.run.id);
      if (latest?.cancelRequestedAt && latest.status === 'awaiting_approval')
        await this.cancelIdle(latest);
      return;
    }
    const state = outcome.state;
    const output: RunOutput = {
      text: state.finalText ?? '',
      structured: state.structuredOutput ?? null,
      citations: state.citations,
      validation: state.validation,
    };
    await this.finish(ctx.run, 'completed', output, null);
  }

  private async handleError(ctx: RunContext, error: unknown, attempt: AttemptInfo): Promise<void> {
    const { logger } = this.deps;
    const reason = ctx.signal.reason;
    if (error instanceof RunStopped) {
      await this.finish(ctx.run, error.status, null, toRunError(error));
      return;
    }
    if (ctx.signal.aborted && reason instanceof RunStopped) {
      await this.finish(ctx.run, reason.status, null, toRunError(reason));
      return;
    }
    const retryable = error instanceof LlmError ? error.retryable : !(error instanceof TypeError);
    if (retryable && attempt.attempt < attempt.maxAttempts) {
      logger.warn(
        { runId: ctx.run.id, err: error, attempt: attempt.attempt },
        'run attempt failed; the job will retry',
      );
      throw error; // BullMQ retries with backoff; the retry resumes from the last checkpoint
    }
    logger.error({ runId: ctx.run.id, err: error }, 'run failed');
    await this.finish(ctx.run, 'failed', null, toRunError(error));
  }

  /**
   * Records the terminal state and lets the channel react (the chat writes the assistant
   * message) in ONE transaction: a run can never be "completed" without its answer existing.
   */
  private async finish(
    run: RunRecord,
    status: TerminalStatus,
    output: RunOutput | null,
    error: RunError | null,
  ): Promise<boolean> {
    const { runs, steps, toolCalls, approvals, tx, clock, completionHandlers, events, audit } =
      this.deps;
    const now = clock.now();
    let messageId: string | null = null;
    const [stepList, callList] = await Promise.all([steps.list(run.id), toolCalls.list(run.id)]);
    const applied = await tx.run(async () => {
      const moved = await runs.transition(
        run.id,
        ACTIVE_STATUSES,
        status,
        {
          output,
          error,
          completedAt: now,
          stepCount: stepList.length,
          toolCallCount: callList.filter(
            (c) => c.status === 'succeeded' || c.status === 'failed' || c.status === 'timed_out',
          ).length,
        },
        now,
      );
      if (!moved) return false;
      for (const pending of await approvals.pendingForRun(run.id)) {
        await approvals.decide(
          pending.id,
          { status: 'cancelled', by: null, comment: `Run ${status}` },
          now,
        );
        await toolCalls.update(pending.toolCallId, {
          status: 'denied',
          outputSummary: `run ${status}`,
          endedAt: now,
        });
      }
      const handler = completionHandlers[run.trigger];
      if (handler) {
        const result = await handler.onRunFinished({
          run: { ...run, status },
          status,
          output,
          error,
        });
        messageId = result.messageId;
      }
      if (status === 'cancelled') {
        await audit.record({
          organizationId: run.organizationId,
          projectId: run.projectId,
          actor: { type: 'system', name: 'agent-runs' },
          action: 'run.cancelled',
          target: { type: 'agent_run', id: run.id },
          runId: run.id,
        });
      }
      return true;
    });
    if (!applied) return false;
    try {
      if (status === 'completed') {
        await events.publish(run.id, {
          type: 'run.completed',
          runId: run.id,
          messageId,
          at: now.toISOString(),
        });
      } else {
        await events.publish(run.id, {
          type: 'run.failed',
          runId: run.id,
          status,
          errorCode: error?.code ?? 'INTERNAL',
          message: error?.message ?? 'The run failed',
          at: now.toISOString(),
        });
      }
      await events.expireLater(run.id);
    } catch (publishError) {
      this.deps.logger.warn(
        { runId: run.id, err: publishError },
        'could not publish the terminal run event',
      );
    }
    await this.deps.workflow.discard(run.id).catch((discardError: unknown) => {
      this.deps.logger.warn(
        { runId: run.id, err: discardError },
        'could not discard run checkpoints',
      );
    });
    this.deps.logger.info({ runId: run.id, status, errorCode: error?.code }, 'run finished');
    return true;
  }
}
