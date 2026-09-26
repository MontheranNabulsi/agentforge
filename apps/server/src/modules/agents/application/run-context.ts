import type { RunError, RunEvent, ToolGrant } from '@agentforge/contracts';
import { newId } from '../../../shared-kernel/ids';
import type { Clock } from '../../../shared-kernel/ports';
import { RunStopped } from '../domain/run-rules';
import type {
  AgentVersionRecord,
  RunRecord,
  RunRepository,
  SourceRef,
  StepKind,
  StepRecord,
  StepRepository,
} from './ports';
import type { AnyAgentTool, SourceChunk, ToolCapabilities } from './tools/agent-tool';

export interface RunProjectInfo {
  id: string;
  organizationId: string;
  name: string;
  description: string;
}

/**
 * Everything one execution of a run needs, assembled by RunContextFactory from the run's
 * pinned agent version. Nodes and tools receive this instead of repositories-at-large.
 */
export interface RunContext {
  run: RunRecord;
  version: AgentVersionRecord;
  agentName: string;
  project: RunProjectInfo;
  /** Evaluation runs: write tools describe their effect instead of performing it. */
  dryRun: boolean;
  signal: AbortSignal;
  deadlineAt: Date;
  grants: ReadonlyMap<string, ToolGrant>;
  /** The granted tools only; the model is never offered anything else. */
  tools: AnyAgentTool[];
  capabilities: ToolCapabilities;
  steps: StepRecorder;
  emit(event: RunEvent): Promise<void>;
  /** Throws RunStopped when the run was cancelled or ran out of time. */
  ensureActive(): Promise<void>;
  recordUsage(usage: { promptTokens: number; completionTokens: number }): Promise<void>;
}

export class ActiveStep {
  constructor(
    readonly record: StepRecord,
    private readonly deps: {
      steps: StepRepository;
      clock: Clock;
      emit: (event: RunEvent) => Promise<void>;
    },
  ) {}

  get id(): string {
    return this.record.id;
  }

  async finish(
    status: 'succeeded' | 'failed' | 'skipped',
    patch: {
      summary: string;
      detail?: Record<string, unknown>;
      model?: string | null;
      promptTokens?: number;
      completionTokens?: number;
      error?: RunError | null;
    },
  ): Promise<void> {
    const endedAt = this.deps.clock.now();
    const durationMs = Math.max(0, endedAt.getTime() - this.record.startedAt.getTime());
    await this.deps.steps.finish(this.record.id, {
      status,
      endedAt,
      durationMs,
      summary: patch.summary.slice(0, 500),
      detail: { ...this.record.detail, ...(patch.detail ?? {}) },
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.promptTokens !== undefined ? { promptTokens: patch.promptTokens } : {}),
      ...(patch.completionTokens !== undefined ? { completionTokens: patch.completionTokens } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    });
    await this.deps.emit({
      type: 'step.completed',
      stepId: this.record.id,
      seq: this.record.seq,
      kind: this.record.kind,
      status,
      summary: patch.summary.slice(0, 500),
      durationMs,
      at: endedAt.toISOString(),
    });
  }
}

/** Writes the run's timeline: one row per step, mirrored to the live event stream. */
export class StepRecorder {
  constructor(
    private readonly deps: {
      steps: StepRepository;
      clock: Clock;
      emit: (event: RunEvent) => Promise<void>;
    },
    private readonly run: { id: string; organizationId: string },
  ) {}

  async start(
    kind: StepKind,
    name: string,
    detail: Record<string, unknown> = {},
  ): Promise<ActiveStep> {
    const now = this.deps.clock.now();
    const seq = await this.deps.steps.nextSeq(this.run.id);
    const record: StepRecord = {
      id: newId(now.getTime()),
      runId: this.run.id,
      organizationId: this.run.organizationId,
      seq,
      kind,
      name,
      status: 'running',
      attempt: 1,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      summary: '',
      detail,
      error: null,
    };
    await this.deps.steps.insert(record);
    await this.deps.emit({
      type: 'step.started',
      stepId: record.id,
      seq,
      kind,
      name,
      attempt: 1,
      at: now.toISOString(),
    });
    return new ActiveStep(record, this.deps);
  }

  /** Finishes a step started in an earlier process (approval waits span a restart). */
  async finishById(
    stepId: string,
    startedAt: Date,
    kind: StepKind,
    status: 'succeeded' | 'failed' | 'skipped',
    summary: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const endedAt = this.deps.clock.now();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    await this.deps.steps.finish(stepId, {
      status,
      endedAt,
      durationMs,
      summary: summary.slice(0, 500),
      detail,
    });
    await this.deps.emit({
      type: 'step.completed',
      stepId,
      seq: 0,
      kind,
      status,
      summary: summary.slice(0, 500),
      durationMs,
      at: endedAt.toISOString(),
    });
  }
}

/** Adds chunks to the run's numbered source list, reusing the index of a chunk already present. */
export function registerSources(sources: SourceRef[], chunks: SourceChunk[]): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const chunk of chunks) {
    let ref = sources.find((s) => s.chunkId === chunk.chunkId);
    if (!ref) {
      ref = {
        index: sources.length + 1,
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        headingPath: chunk.headingPath,
        pageNumber: chunk.pageNumber,
        content: chunk.content,
      };
      sources.push(ref);
    }
    refs.push(ref);
  }
  return refs;
}

export interface RunContextHandle {
  ctx: RunContext;
  dispose(): void;
}

/** Deadline + cancellation checks shared by every node. */
export function makeActivityGuard(
  deps: { runs: RunRepository; clock: Clock },
  runId: string,
  deadlineAt: Date,
) {
  return async () => {
    const now = deps.clock.now();
    if (now.getTime() > deadlineAt.getTime()) {
      throw new RunStopped('DEADLINE_EXCEEDED', 'The run exceeded its time limit', 'timed_out');
    }
    const current = await deps.runs.findById(runId);
    if (current?.cancelRequestedAt)
      throw new RunStopped('CANCELLED', 'The run was cancelled', 'cancelled');
  };
}
