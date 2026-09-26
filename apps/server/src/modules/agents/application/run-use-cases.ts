import type {
  Page,
  RunDetailDto,
  RunSummaryDto,
  RunTrigger,
  StepDto,
  ToolCallDto,
  ToolName,
} from '@agentforge/contracts';
import { notFound, rateLimited } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { LlmProvider } from '../../../shared-kernel/ai';
import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { truncate } from '../../../shared-kernel/text';
import type { AuditLog } from '../../audit';
import type { ProjectAccess } from '../../projects';
import type { RunStatus } from '../domain/run-rules';
import { isTerminal } from '../domain/run-rules';
import type { AgentRunOrchestrator } from './agent-run-orchestrator';
import type {
  AgentRepository,
  AgentVersionRecord,
  NewRun,
  RunRecord,
  RunRepository,
  StepRecord,
  StepRepository,
  ToolCallRecord,
  ToolCallRepository,
} from './ports';

type NamedActor = Actor & { name?: string };

export const toRunSummaryDto = (run: RunRecord): RunSummaryDto => ({
  id: run.id,
  projectId: run.projectId,
  agentId: run.agentId,
  agentName: run.agentName,
  agentVersion: run.agentVersion,
  trigger: run.trigger,
  triggerRefId: run.triggerRefId,
  status: run.status,
  intent: run.intent,
  inputPreview: truncate(run.input, 140),
  errorCode: run.error?.code ?? null,
  provider: run.provider,
  model: run.model,
  promptTokens: run.promptTokens,
  completionTokens: run.completionTokens,
  totalTokens: run.promptTokens + run.completionTokens,
  stepCount: run.stepCount,
  toolCallCount: run.toolCallCount,
  durationMs:
    run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null,
  requestId: run.requestId,
  traceId: run.traceId,
  createdAt: run.createdAt.toISOString(),
  startedAt: run.startedAt?.toISOString() ?? null,
  completedAt: run.completedAt?.toISOString() ?? null,
});

export const toStepDto = (s: StepRecord): StepDto => ({
  id: s.id,
  seq: s.seq,
  kind: s.kind,
  name: s.name,
  status: s.status,
  attempt: s.attempt,
  startedAt: s.startedAt.toISOString(),
  endedAt: s.endedAt?.toISOString() ?? null,
  durationMs: s.durationMs,
  model: s.model,
  promptTokens: s.promptTokens,
  completionTokens: s.completionTokens,
  summary: s.summary,
  detail: s.detail,
  error: s.error,
});

export const toToolCallDto = (c: ToolCallRecord): ToolCallDto => ({
  id: c.id,
  stepId: c.stepId,
  toolName: c.toolName as ToolName,
  status: c.status,
  input: c.input,
  inputSummary: c.inputSummary,
  output: c.output ?? null,
  outputSummary: c.outputSummary,
  error: c.error,
  attempt: c.attempt,
  durationMs: c.durationMs,
  approvalId: c.approvalId ?? null,
  createdAt: c.createdAt.toISOString(),
  startedAt: c.startedAt?.toISOString() ?? null,
  endedAt: c.endedAt?.toISOString() ?? null,
});

export function toRunDetailDto(
  run: RunRecord,
  version: AgentVersionRecord | null,
  steps: StepRecord[],
  calls: ToolCallRecord[],
): RunDetailDto {
  return {
    ...toRunSummaryDto(run),
    input: run.input,
    plan: run.plan,
    output: run.output,
    error: run.error,
    deadlineAt: run.deadlineAt?.toISOString() ?? null,
    agentConfig: {
      versionId: run.agentVersionId,
      modelProfile: version?.modelProfile ?? 'default',
      tools: version?.tools.map((t) => t.tool) ?? [],
      promptVersion: version?.promptVersion ?? 'unknown',
    },
    steps: steps.map(toStepDto),
    toolCalls: calls.map(toToolCallDto),
  };
}

export interface RunUseCaseDeps {
  agents: AgentRepository;
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  projectAccess: ProjectAccess;
  orchestrator: AgentRunOrchestrator;
  llm: LlmProvider;
  jobs: BackgroundJobs;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
  limits: { maxActiveRunsPerOrg: number; dailyTokenBudgetPerOrg: number };
}

export interface StartRunParams {
  actor: NamedActor;
  projectId: string;
  agentId: string;
  trigger: RunTrigger;
  triggerRefId: string;
  input: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Chat runs go through the queue; evaluations execute their runs inline. */
  enqueue: boolean;
  requestId?: string | null;
}

export class RunUseCases {
  constructor(private readonly deps: RunUseCaseDeps) {}

  /**
   * Creates a queued run for a channel. Call inside the channel's transaction so the channel's
   * own row (the user's message) and the run commit together, or neither does.
   */
  async startRun(params: StartRunParams): Promise<RunRecord> {
    const { agents, runs, projectAccess, jobs, audit, tx, clock, llm, limits } = this.deps;
    const { project } = await projectAccess.require(params.actor, params.projectId, 'run:create');
    const agent = await agents.findById(params.agentId);
    if (!agent || agent.projectId !== params.projectId || agent.archivedAt)
      throw notFound('AGENT_NOT_FOUND', 'Agent not found');

    const now = clock.now();
    if ((await runs.countActive(project.organizationId)) >= limits.maxActiveRunsPerOrg) {
      throw rateLimited(
        'TOO_MANY_ACTIVE_RUNS',
        `Your organization already has ${limits.maxActiveRunsPerOrg} runs in progress; wait for one to finish`,
      );
    }
    const used = await runs.tokensUsedSince(
      project.organizationId,
      new Date(now.getTime() - 24 * 3600 * 1000),
    );
    if (used >= limits.dailyTokenBudgetPerOrg) {
      throw rateLimited(
        'DAILY_TOKEN_BUDGET_EXCEEDED',
        'Your organization used its daily token budget; try again tomorrow',
      );
    }

    const run: NewRun = {
      id: newId(now.getTime()),
      organizationId: project.organizationId,
      projectId: params.projectId,
      agentId: agent.id,
      agentVersionId: agent.currentVersion.id,
      trigger: params.trigger,
      triggerRefId: params.triggerRefId,
      triggeredBy: params.actor.userId,
      input: params.input,
      history: params.history,
      status: 'queued',
      intent: null,
      plan: null,
      output: null,
      error: null,
      provider: llm.name,
      model: llm.modelFor(agent.currentVersion.modelProfile),
      promptTokens: 0,
      completionTokens: 0,
      stepCount: 0,
      toolCallCount: 0,
      requestId: params.requestId ?? null,
      traceId: null,
      deadlineAt: null,
      cancelRequestedAt: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };
    await tx.run(async () => {
      await runs.create(run);
      await audit.record({
        organizationId: project.organizationId,
        projectId: params.projectId,
        actor: {
          type: 'user',
          id: params.actor.userId,
          ...(params.actor.name ? { name: params.actor.name } : {}),
        },
        action: 'run.started',
        target: { type: 'agent_run', id: run.id },
        metadata: {
          agent: agent.name,
          agentVersion: agent.currentVersion.version,
          trigger: params.trigger,
        },
        runId: run.id,
      });
      if (params.enqueue)
        await jobs.enqueue('agent-run.execute', { runId: run.id }, { dedupeKey: `run-${run.id}` });
    });
    return {
      ...run,
      agentName: agent.name,
      agentVersion: agent.currentVersion.version,
      updatedAt: now,
    };
  }

  async list(
    actor: Actor,
    projectId: string,
    filter: {
      limit: number;
      cursor?: string;
      status?: RunStatus;
      agentId?: string;
      trigger?: RunTrigger;
    },
  ): Promise<Page<RunRecord>> {
    await this.deps.projectAccess.require(actor, projectId, 'run:read');
    return this.deps.runs.list({ projectId, ...filter });
  }

  async authorize(actor: Actor, runId: string): Promise<RunRecord> {
    const run = await this.deps.runs.findById(runId);
    if (!run) throw notFound('RUN_NOT_FOUND', 'Run not found');
    await this.deps.projectAccess.require(actor, run.projectId, 'run:read');
    return run;
  }

  async get(actor: Actor, runId: string): Promise<RunDetailDto> {
    const run = await this.authorize(actor, runId);
    const [version, steps, calls] = await Promise.all([
      this.deps.agents.findVersion(run.agentVersionId),
      this.deps.steps.list(run.id),
      this.deps.toolCalls.list(run.id),
    ]);
    return toRunDetailDto(run, version, steps, calls);
  }

  /**
   * Cancellation is cooperative. A queued or approval-waiting run is cancelled at once; a
   * running one is flagged and stops at the next node boundary (between model/tool calls).
   */
  async cancel(actor: NamedActor, runId: string): Promise<RunRecord> {
    const { runs, projectAccess, clock } = this.deps;
    const run = await runs.findById(runId);
    if (!run) throw notFound('RUN_NOT_FOUND', 'Run not found');
    await projectAccess.require(actor, run.projectId, 'run:cancel');
    if (isTerminal(run.status)) return run;
    const now = clock.now();
    await runs.update(run.id, { cancelRequestedAt: now }, now);
    await this.deps.orchestrator.cancelIdle({ ...run, cancelRequestedAt: now });
    return (await runs.findById(run.id))!;
  }
}
