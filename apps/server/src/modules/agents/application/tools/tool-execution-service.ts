import type { RunError, ToolCallStatus } from '@agentforge/contracts';
import type { LlmMessage } from '../../../../shared-kernel/ai';
import { newId } from '../../../../shared-kernel/ids';
import type { Clock, TransactionRunner } from '../../../../shared-kernel/ports';
import { truncate } from '../../../../shared-kernel/text';
import type { AuditLog } from '../../../audit';
import { evaluateApproval } from '../../domain/approval-policy';
import type { ActiveStep, RunContext } from '../run-context';
import { registerSources } from '../run-context';
import type {
  ApprovalRepository,
  MemberPermissions,
  PendingToolCall,
  SourceRef,
  ToolCallRecord,
  ToolCallRepository,
} from '../ports';
import type { AnyAgentTool, SourceChunk, ToolContext } from './agent-tool';
import type { ToolRegistry } from './builtin-tools';

type ToolMessage = Extract<LlmMessage, { role: 'tool' }>;

export type ToolResult = {
  kind: 'result';
  message: ToolMessage;
  sources: SourceRef[];
  executed: boolean;
};
export type ToolOutcome =
  | ToolResult
  | {
      kind: 'needs_approval';
      approvalId: string;
      toolCallId: string;
      stepId: string;
      requestedAt: string;
    };

const TERMINAL: ReadonlySet<ToolCallStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'denied',
]);
const MAX_OUTPUT_FOR_MODEL = 12_000;
const MAX_STORED_OUTPUT = 24_000;

class ToolTimeout extends Error {
  constructor(ms: number) {
    super(`The tool did not finish within ${ms} ms`);
    this.name = 'ToolTimeout';
  }
}

export interface ToolExecutionDeps {
  registry: ToolRegistry;
  toolCalls: ToolCallRepository;
  approvals: ApprovalRepository;
  permissions: MemberPermissions;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
}

/**
 * The only way a model's tool request becomes an action. For every call, in order:
 *   1. idempotency: a call with the same runId:turn:index key that already finished is replayed,
 *      never re-executed (a retried job must not create a second note or send a second POST);
 *   2. the tool must be granted to this agent version (the model may ask for anything);
 *   3. the input must validate against the tool's Zod schema;
 *   4. the user who triggered the run must hold the tool's permission (agents act on behalf of
 *      a person and never exceed that person's role);
 *   5. the approval policy decides whether a person must say yes first;
 *   6. execution is bounded by the tool's timeout and the run's deadline; output is summarized,
 *      stored, audited (for side effects) and returned to the model as untrusted data.
 */
export class ToolExecutionService {
  constructor(private readonly deps: ToolExecutionDeps) {}

  async execute(
    ctx: RunContext,
    pending: PendingToolCall,
    sources: SourceRef[],
  ): Promise<ToolOutcome> {
    const { toolCalls, clock } = this.deps;
    const existing = await toolCalls.findByKey(pending.key);
    if (existing && TERMINAL.has(existing.status)) return this.replay(existing, pending, sources);
    if (existing?.status === 'awaiting_approval') {
      const approval = await this.deps.approvals.findByToolCall(existing.id);
      if (approval?.status === 'pending') {
        return {
          kind: 'needs_approval',
          approvalId: approval.id,
          toolCallId: existing.id,
          stepId: existing.stepId ?? existing.id,
          requestedAt: approval.requestedAt.toISOString(),
        };
      }
    }

    const tool = this.deps.registry.get(pending.call.name);
    const grant = ctx.grants.get(pending.call.name);
    const step = await ctx.steps.start('tool_call', pending.call.name, {
      input: pending.call.input,
    });
    const now = clock.now();
    const record: ToolCallRecord = existing ?? {
      id: newId(now.getTime()),
      runId: ctx.run.id,
      stepId: step.id,
      organizationId: ctx.project.organizationId,
      projectId: ctx.project.id,
      toolName: pending.call.name,
      providerCallId: pending.call.id,
      idempotencyKey: pending.key,
      status: 'proposed',
      input: pending.call.input,
      inputSummary: '',
      output: null,
      outputSummary: null,
      error: null,
      attempt: 1,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      durationMs: null,
    };
    if (existing) {
      record.attempt = existing.attempt + 1;
      record.stepId = step.id;
      await toolCalls.update(existing.id, { attempt: record.attempt, stepId: step.id });
      if (
        existing.status === 'executing' &&
        tool &&
        tool.effectFor(existing.input as never) === 'write'
      ) {
        // The previous attempt crashed mid-write: we cannot know whether the effect happened,
        // so we refuse to guess and report it instead of risking a duplicate side effect.
        return this.fail(ctx, record, step, sources, {
          code: 'TOOL_INTERRUPTED',
          message:
            'A previous attempt of this action was interrupted; it was not retried automatically to avoid doing it twice.',
          retryable: false,
        });
      }
      if (existing.status === 'approved' && tool) {
        const parsed = tool.input.safeParse(existing.input);
        if (parsed.success) return this.run(ctx, tool, parsed.data, record, step, sources);
      }
    } else {
      await toolCalls.insert(record);
    }

    if (!tool || !grant) {
      return this.fail(ctx, record, step, sources, {
        code: 'TOOL_NOT_ALLOWED',
        message: `The tool "${pending.call.name}" is not available to this agent. Available tools: ${ctx.tools.map((t) => t.name).join(', ') || 'none'}.`,
        retryable: false,
      });
    }

    const parsed = tool.input.safeParse(pending.call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ');
      return this.fail(ctx, record, step, sources, {
        code: 'INVALID_TOOL_INPUT',
        message: `Invalid input for ${tool.name}: ${issues}`,
        retryable: false,
      });
    }
    const input = parsed.data as Record<string, unknown>;
    record.inputSummary = safe(() => tool.summarizeInput(input), pending.call.name);

    const triggeredBy = ctx.run.triggeredBy;
    const role = triggeredBy
      ? await this.deps.permissions.roleOf(triggeredBy, ctx.project.organizationId)
      : null;
    if (!role || !this.deps.permissions.allows(role, tool.permission)) {
      return this.fail(ctx, record, step, sources, {
        code: 'TOOL_PERMISSION_DENIED',
        message: `The person who started this run (${role ?? 'no longer a member'}) is not allowed to ${tool.permission.replace(':', ' ')}, so the agent cannot either.`,
        retryable: false,
      });
    }

    if (tool.name === 'http_request' && input.method !== 'GET' && grant.allowWrite !== true) {
      return this.fail(ctx, record, step, sources, {
        code: 'METHOD_NOT_ALLOWED',
        message: `This agent may only send GET requests; ${String(input.method)} is not enabled for it.`,
        retryable: false,
      });
    }

    const requirement = evaluateApproval({
      toolName: tool.name,
      effect: tool.effectFor(input),
      risk: tool.risk,
      autoApproveGranted: grant.autoApprove === true,
    });

    if (requirement.required && ctx.dryRun) {
      // Evaluations never wait for a person: record that approval would have been requested.
      const output = {
        dryRun: true,
        approvalRequired: true,
        message: 'Evaluation run: this action needs human approval, so it was not performed.',
      };
      await toolCalls.update(record.id, {
        status: 'denied',
        inputSummary: record.inputSummary,
        output,
        outputSummary: 'approval required (evaluation dry run)',
        endedAt: clock.now(),
      });
      await step.finish('skipped', {
        summary: `${record.inputSummary}: approval required, not executed (evaluation)`,
      });
      return {
        kind: 'result',
        message: this.toolMessage(pending, output, false),
        sources,
        executed: false,
      };
    }

    if (requirement.required) {
      const preview = tool.approvalPreview?.(input) ?? {
        title: `Run ${tool.title}`,
        summary: `The agent wants to run ${tool.title}: ${record.inputSummary}`,
        payload: input,
      };
      const requestedAt = clock.now();
      const approvalId = newId(requestedAt.getTime());
      await this.deps.tx.run(async () => {
        await toolCalls.update(record.id, {
          status: 'awaiting_approval',
          inputSummary: record.inputSummary,
        });
        await this.deps.approvals.insert({
          id: approvalId,
          organizationId: ctx.project.organizationId,
          projectId: ctx.project.id,
          runId: ctx.run.id,
          toolCallId: record.id,
          riskLevel: requirement.riskLevel,
          title: preview.title,
          summary: preview.summary,
          payload: preview.payload,
          policyReason: requirement.reason,
          approverRoles: requirement.approverRoles,
          status: 'pending',
          requestedBy: triggeredBy,
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + requirement.expiresInMs),
          decidedBy: null,
          decidedAt: null,
          decisionComment: null,
        });
        await this.deps.audit.record({
          organizationId: ctx.project.organizationId,
          projectId: ctx.project.id,
          actor: {
            type: 'agent',
            id: ctx.version.agentId,
            name: ctx.agentName,
            onBehalfOfUserId: triggeredBy ?? '',
          },
          action: 'approval.requested',
          target: { type: 'tool_call', id: record.id },
          metadata: {
            tool: tool.name,
            riskLevel: requirement.riskLevel,
            approvalId,
            reason: requirement.reason,
          },
          runId: ctx.run.id,
        });
      });
      await step.finish('succeeded', {
        summary: `${record.inputSummary}: needs approval (${requirement.riskLevel} risk)`,
        detail: { approvalId, policy: requirement.reason },
      });
      const wait = await ctx.steps.start('approval_wait', `Approval: ${tool.title}`, {
        approvalId,
        toolCallId: record.id,
      });
      await ctx.emit({
        type: 'approval.requested',
        approvalId,
        toolCallId: record.id,
        toolName: tool.name,
        title: preview.title,
        summary: preview.summary,
        riskLevel: requirement.riskLevel,
        at: requestedAt.toISOString(),
      });
      return {
        kind: 'needs_approval',
        approvalId,
        toolCallId: record.id,
        stepId: wait.id,
        requestedAt: requestedAt.toISOString(),
      };
    }

    if (requirement.preApproved) {
      const at = clock.now();
      await this.deps.approvals.insert({
        id: newId(at.getTime()),
        organizationId: ctx.project.organizationId,
        projectId: ctx.project.id,
        runId: ctx.run.id,
        toolCallId: record.id,
        riskLevel: requirement.riskLevel,
        title: tool.approvalPreview?.(input).title ?? `Run ${tool.title}`,
        summary: 'Pre-approved by an admin rule on this agent.',
        payload: input,
        policyReason: requirement.reason,
        approverRoles: requirement.approverRoles,
        status: 'approved',
        requestedBy: triggeredBy,
        requestedAt: at,
        expiresAt: at,
        decidedBy: null,
        decidedAt: at,
        decisionComment: requirement.reason,
      });
    }

    return this.run(ctx, tool, input, record, step, sources);
  }

  /**
   * After a person decided. The decision use case already moved the tool call to approved or
   * denied (with the denial stored as output), so this either executes it or replays the denial.
   */
  async afterDecision(
    ctx: RunContext,
    pending: PendingToolCall,
    sources: SourceRef[],
  ): Promise<ToolResult> {
    const record = await this.deps.toolCalls.findByKey(pending.key);
    if (!record) {
      const output = {
        status: 'rejected',
        denied: true,
        message: 'The action could not be found after approval.',
      };
      return {
        kind: 'result',
        message: this.toolMessage(pending, output, true),
        sources,
        executed: false,
      };
    }
    if (TERMINAL.has(record.status)) return this.replay(record, pending, sources);
    const tool = this.deps.registry.get(record.toolName);
    const parsed = tool?.input.safeParse(record.input);
    if (record.status !== 'approved' || !tool || !parsed?.success) {
      const output = {
        status: 'rejected',
        denied: true,
        message: 'This action was not approved. Do not retry it; tell the user.',
      };
      await this.deps.toolCalls.update(record.id, {
        status: 'denied',
        output,
        outputSummary: 'not approved',
        endedAt: this.deps.clock.now(),
      });
      return {
        kind: 'result',
        message: this.toolMessage(pending, output, false),
        sources,
        executed: false,
      };
    }
    const step = await ctx.steps.start('tool_call', record.toolName, {
      input: record.input,
      approved: true,
    });
    await this.deps.toolCalls.update(record.id, { stepId: step.id });
    return this.run(
      ctx,
      tool,
      parsed.data as Record<string, unknown>,
      { ...record, stepId: step.id },
      step,
      sources,
    );
  }

  private async run(
    ctx: RunContext,
    tool: AnyAgentTool,
    input: Record<string, unknown>,
    record: ToolCallRecord,
    step: ActiveStep,
    sources: SourceRef[],
  ): Promise<ToolResult> {
    const { toolCalls, clock } = this.deps;
    const startedAt = clock.now();
    const inputSummary = record.inputSummary || safe(() => tool.summarizeInput(input), tool.name);
    await toolCalls.update(record.id, { status: 'executing', startedAt, inputSummary });
    await ctx.emit({
      type: 'tool_call.started',
      toolCallId: record.id,
      toolName: tool.name,
      inputSummary,
      at: startedAt.toISOString(),
    });

    const localSources = [...sources];
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const toolContext: ToolContext = {
      runId: ctx.run.id,
      projectId: ctx.project.id,
      organizationId: ctx.project.organizationId,
      actorUserId: ctx.run.triggeredBy ?? '',
      grant: ctx.grants.get(tool.name) ?? { tool: tool.name },
      signal,
      capabilities: ctx.capabilities,
      registerSources: (chunks: SourceChunk[]) => registerSources(localSources, chunks),
      dryRun: ctx.dryRun,
    };

    try {
      const output: unknown = await withTimeout(
        tool.execute(input, toolContext),
        tool.timeoutMs,
        controller,
        ctx.signal,
      );
      const endedAt = clock.now();
      const durationMs = endedAt.getTime() - startedAt.getTime();
      const outputSummary = safe(() => tool.summarizeOutput(output), 'done');
      const effect = tool.effectFor(input);
      await this.deps.tx.run(async () => {
        await toolCalls.update(record.id, {
          status: 'succeeded',
          output: capStored(output),
          outputSummary,
          endedAt,
          durationMs,
          error: null,
        });
        if (effect !== 'read') {
          await this.deps.audit.record({
            organizationId: ctx.project.organizationId,
            projectId: ctx.project.id,
            actor: {
              type: 'agent',
              id: ctx.version.agentId,
              name: ctx.agentName,
              onBehalfOfUserId: ctx.run.triggeredBy ?? '',
            },
            action: 'tool.executed',
            target: { type: 'tool_call', id: record.id },
            metadata: {
              tool: tool.name,
              effect,
              input: inputSummary,
              output: outputSummary,
              dryRun: ctx.dryRun,
            },
            runId: ctx.run.id,
          });
        }
      });
      await step.finish('succeeded', {
        summary: `${inputSummary} → ${outputSummary}`,
        detail: { durationMs },
      });
      await ctx.emit({
        type: 'tool_call.completed',
        toolCallId: record.id,
        toolName: tool.name,
        status: 'succeeded',
        outputSummary,
        durationMs,
        at: endedAt.toISOString(),
      });
      return {
        kind: 'result',
        message: this.toolMessage(
          {
            call: { id: record.providerCallId ?? record.id, name: tool.name, input },
            key: record.idempotencyKey,
          },
          output,
          false,
        ),
        sources: localSources,
        executed: true,
      };
    } catch (error) {
      if (ctx.signal.aborted && !(error instanceof ToolTimeout)) throw error; // run deadline/cancel: handled by the orchestrator
      const timedOut = error instanceof ToolTimeout;
      const code = timedOut ? 'TOOL_TIMEOUT' : ((error as { code?: string }).code ?? 'TOOL_ERROR');
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(
        ctx,
        { ...record, inputSummary },
        step,
        sources,
        { code, message: truncate(message, 400), retryable: timedOut },
        startedAt,
        timedOut ? 'timed_out' : 'failed',
      );
    }
  }

  private async fail(
    ctx: RunContext,
    record: ToolCallRecord,
    step: ActiveStep,
    sources: SourceRef[],
    error: RunError,
    startedAt?: Date,
    status: 'failed' | 'timed_out' = 'failed',
  ): Promise<ToolResult> {
    const endedAt = this.deps.clock.now();
    const durationMs = startedAt ? endedAt.getTime() - startedAt.getTime() : null;
    await this.deps.toolCalls.update(record.id, {
      status,
      error,
      output: { error: error.code, message: error.message },
      outputSummary: error.code,
      inputSummary: record.inputSummary,
      endedAt,
      durationMs,
    });
    await step.finish('failed', { summary: `${error.code}: ${error.message}`, error });
    await ctx.emit({
      type: 'tool_call.completed',
      toolCallId: record.id,
      toolName: record.toolName,
      status,
      outputSummary: error.code,
      durationMs,
      at: endedAt.toISOString(),
    });
    return {
      kind: 'result',
      message: {
        role: 'tool',
        toolCallId: record.providerCallId ?? record.id,
        toolName: record.toolName,
        content: JSON.stringify({ error: error.code, message: error.message }),
        isError: true,
      },
      sources,
      executed: false,
    };
  }

  /** A finished call, returned again without re-running it (idempotent retries). */
  private replay(
    record: ToolCallRecord,
    pending: PendingToolCall,
    sources: SourceRef[],
  ): ToolResult {
    const updated = [...sources];
    const output = record.output as { results?: unknown[]; passages?: unknown[] } | null;
    const cited = [...(output?.results ?? []), ...(output?.passages ?? [])] as Partial<
      SourceChunk & { sourceIndex: number }
    >[];
    const chunks = cited.filter(
      (c): c is SourceChunk & { sourceIndex: number } =>
        typeof c.chunkId === 'string' && typeof c.documentId === 'string',
    );
    registerSources(
      updated,
      chunks.map((c) => ({
        ...c,
        pageNumber: c.pageNumber ?? null,
        headingPath: c.headingPath ?? '',
      })),
    );
    const isError = record.status === 'failed' || record.status === 'timed_out';
    return {
      kind: 'result',
      message: {
        role: 'tool',
        toolCallId: pending.call.id,
        toolName: record.toolName,
        content: JSON.stringify(record.output ?? { error: record.error?.code ?? 'UNKNOWN' }).slice(
          0,
          MAX_OUTPUT_FOR_MODEL,
        ),
        ...(isError ? { isError: true } : {}),
      },
      sources: updated,
      executed: false,
    };
  }

  private toolMessage(pending: PendingToolCall, output: unknown, isError: boolean): ToolMessage {
    const json = JSON.stringify(output ?? null);
    return {
      role: 'tool',
      toolCallId: pending.call.id,
      toolName: pending.call.name,
      content:
        json.length > MAX_OUTPUT_FOR_MODEL
          ? `${json.slice(0, MAX_OUTPUT_FOR_MODEL)}…[truncated]`
          : json,
      ...(isError ? { isError: true } : {}),
    };
  }
}

function safe(fn: () => string, fallback: string): string {
  try {
    return truncate(fn(), 200);
  } catch {
    return fallback;
  }
}

function capStored(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  if (json.length <= MAX_STORED_OUTPUT) return output ?? null;
  return { truncated: true, preview: json.slice(0, MAX_STORED_OUTPUT) };
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
  runSignal: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolTimeout(ms));
    }, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (runSignal.aborted)
      reject(runSignal.reason instanceof Error ? runSignal.reason : new Error('aborted'));
    runSignal.addEventListener(
      'abort',
      () => reject(runSignal.reason instanceof Error ? runSignal.reason : new Error('aborted')),
      { once: true },
    );
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    clearTimeout(timer);
  }
}
