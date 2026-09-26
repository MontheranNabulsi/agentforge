import type { Citation, RunError, ValidationResult } from '@agentforge/contracts';
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmStopReason,
  type LlmToolCall,
  type LlmUsage,
} from '../../../shared-kernel/ai';
import type { Clock } from '../../../shared-kernel/ports';
import { truncate } from '../../../shared-kernel/text';
import {
  citedIndices,
  extractJson,
  looksLikeRefusal,
  redactSecrets,
  stripUnknownCitations,
} from '../domain/response-checks';
import { budgetViolation, RunStopped } from '../domain/run-rules';
import {
  actSystemPrompt,
  CLASSIFY_SYSTEM,
  ClassificationSchema,
  classifyMessages,
  initialTranscript,
  injectionSignals,
  normalizePlan,
  planSystemPrompt,
  PlanSchema,
  refusalText,
  repairMessage,
  requestMessage,
} from './prompts';
import { registerSources, type RunContext } from './run-context';
import type {
  ApprovalResume,
  KnowledgeGateway,
  OutputSchemaValidator,
  RunGraphState,
  RunRepository,
} from './ports';
import type { ToolExecutionService } from './tools/tool-execution-service';
import type { ToolRegistry } from './tools/builtin-tools';

/** Graph node names (must differ from state field names, so "make_plan" rather than "plan"). */
export type NodeName =
  | 'classify'
  | 'make_plan'
  | 'retrieve'
  | 'act'
  | 'tools'
  | 'await_approval'
  | 'validate'
  | 'refuse'
  | 'finalize';

export interface RunNodeDeps {
  llm: LlmProvider;
  registry: ToolRegistry;
  toolExecution: ToolExecutionService;
  knowledge: KnowledgeGateway;
  runs: RunRepository;
  validator: OutputSchemaValidator;
  clock: Clock;
}

export function initialRunState(runId: string): RunGraphState {
  return {
    runId,
    intent: null,
    needsKnowledge: false,
    riskFlags: [],
    plan: null,
    sources: [],
    transcript: [],
    pendingToolCalls: [],
    pendingApproval: null,
    finalText: null,
    lastStopReason: null,
    structuredOutput: null,
    refusal: false,
    repairRequested: false,
    validation: null,
    citations: [],
    repairAttempts: 0,
    modelTurns: 0,
    toolCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

export function toRunError(error: unknown): RunError {
  if (error instanceof RunStopped)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof LlmError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? truncate(error.message, 300) : 'Unexpected error',
    retryable: false,
  };
}

const NO_ANSWER =
  /\b(couldn'?t find|could not find|don'?t (have|know)|no information|not (mentioned|covered|in the (documents|sources))|won'?t guess)\b/i;

/**
 * The run's behaviour, one method per graph node. Pure application code: each method takes the
 * checkpointed state and returns the fields it changes. The LangGraph adapter only wires these
 * together; it adds no logic of its own, so the graph can be replaced without touching this file.
 */
export class RunNodes {
  constructor(
    private readonly deps: RunNodeDeps,
    private readonly ctx: RunContext,
  ) {}

  // ---- routing -------------------------------------------------------------------------

  static afterClassify(state: RunGraphState): NodeName {
    if (state.intent === 'unsafe' || state.intent === 'out_of_scope') return 'refuse';
    if (state.intent === 'chitchat') return 'act';
    if (state.intent === 'task') return 'make_plan';
    return state.needsKnowledge ? 'retrieve' : 'act';
  }

  static afterPlan(state: RunGraphState): NodeName {
    return state.needsKnowledge ? 'retrieve' : 'act';
  }

  static afterAct(state: RunGraphState): NodeName {
    return state.pendingToolCalls.length > 0 ? 'tools' : 'validate';
  }

  static afterTools(state: RunGraphState): NodeName {
    if (state.pendingApproval) return 'await_approval';
    return state.pendingToolCalls.length > 0 ? 'tools' : 'act';
  }

  static afterApproval(state: RunGraphState): NodeName {
    return state.pendingToolCalls.length > 0 ? 'tools' : 'act';
  }

  static afterValidate(state: RunGraphState): NodeName {
    return state.repairRequested ? 'act' : 'finalize';
  }

  // ---- nodes ---------------------------------------------------------------------------

  async classify(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    await ctx.ensureActive();
    const step = await ctx.steps.start('classify', 'Classify request');
    const guard = injectionSignals(ctx.run.input);
    try {
      let intent: RunGraphState['intent'];
      let needsKnowledge: boolean;
      let riskFlags: string[];
      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, estimated: true };
      let model: string | null = null;
      try {
        const result = await deps.llm.generateObject(
          {
            profile: 'fast',
            purpose: 'classify',
            system: CLASSIFY_SYSTEM,
            messages: classifyMessages(ctx.run.input),
            schema: ClassificationSchema,
            maxTokens: 300,
          },
          ctx.signal,
        );
        ({ intent, needsKnowledge, riskFlags } = result.object);
        usage = result.usage;
        model = result.model;
      } catch (error) {
        if (!(error instanceof LlmError) || error.code !== 'LLM_INVALID_OUTPUT') throw error;
        // A malformed classification is not worth failing the run: treat it as a question.
        intent = 'question';
        needsKnowledge = true;
        riskFlags = ['classifier_fallback'];
      }
      if (guard.length > 0) {
        intent = 'unsafe';
        riskFlags = [...new Set([...riskFlags, ...guard])];
      }
      await ctx.recordUsage({
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
      });
      await deps.runs.update(ctx.run.id, { intent }, deps.clock.now());
      await step.finish('succeeded', {
        summary: `${intent}${needsKnowledge ? ' · needs knowledge' : ''}${riskFlags.length ? ` · flags: ${riskFlags.join(', ')}` : ''}`,
        detail: { intent, needsKnowledge, riskFlags, deterministicGuard: guard },
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
      });
      return {
        intent,
        needsKnowledge,
        riskFlags,
        promptTokens: state.promptTokens + usage.inputTokens,
        completionTokens: state.completionTokens + usage.outputTokens,
      };
    } catch (error) {
      await step.finish('failed', { summary: toRunError(error).message, error: toRunError(error) });
      throw error;
    }
  }

  async plan(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    await ctx.ensureActive();
    if (ctx.tools.length === 0) return {};
    const step = await ctx.steps.start('plan', 'Plan');
    try {
      const result = await deps.llm.generateObject(
        {
          profile: ctx.version.modelProfile,
          purpose: 'plan',
          system: planSystemPrompt(ctx.tools, state.needsKnowledge),
          messages: [{ role: 'user', content: requestMessage(ctx.run.input, null) }],
          schema: PlanSchema,
          maxTokens: 700,
        },
        ctx.signal,
      );
      const plan = normalizePlan(result.object, new Set(ctx.tools.map((t) => t.name)));
      await ctx.recordUsage({
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
      });
      await deps.runs.update(ctx.run.id, { plan }, deps.clock.now());
      await step.finish('succeeded', {
        summary: plan.steps.map((s) => s.tool ?? 'answer').join(' → '),
        detail: { plan },
        model: result.model,
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
      });
      return {
        plan,
        promptTokens: state.promptTokens + result.usage.inputTokens,
        completionTokens: state.completionTokens + result.usage.outputTokens,
      };
    } catch (error) {
      if (error instanceof LlmError && error.code === 'LLM_INVALID_OUTPUT') {
        await step.finish('failed', {
          summary: 'The plan was malformed; continuing without one',
          error: toRunError(error),
        });
        return { plan: null };
      }
      await step.finish('failed', { summary: toRunError(error).message, error: toRunError(error) });
      throw error;
    }
  }

  async retrieve(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    await ctx.ensureActive();
    const step = await ctx.steps.start('retrieve', 'Retrieve knowledge', {
      query: truncate(ctx.run.input, 300),
    });
    try {
      const chunks = await deps.knowledge.retrieve(
        ctx.project.id,
        ctx.run.input,
        ctx.version.retrieval.topK,
      );
      const sources = [...state.sources];
      registerSources(sources, chunks);
      const documents = new Set(chunks.map((c) => c.documentId)).size;
      await step.finish('succeeded', {
        summary: chunks.length
          ? `${chunks.length} passages from ${documents} document${documents === 1 ? '' : 's'}`
          : 'no matching passages',
        detail: {
          passages: sources.map((s) => ({
            index: s.index,
            document: s.documentTitle,
            section: s.headingPath,
            score: chunks.find((c) => c.chunkId === s.chunkId)?.score ?? null,
          })),
        },
      });
      return { sources };
    } catch (error) {
      if (error instanceof RunStopped) throw error;
      // Retrieval is best effort: without it the agent answers "not found" instead of failing.
      await step.finish('failed', {
        summary: `Retrieval failed: ${toRunError(error).message}`,
        error: toRunError(error),
      });
      return {};
    }
  }

  async act(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    await ctx.ensureActive();
    const violation = budgetViolation(
      {
        modelTurns: state.modelTurns,
        toolCalls: state.toolCallCount,
        tokens: state.promptTokens + state.completionTokens,
      },
      ctx.version.limits,
      deps.clock.now(),
      ctx.deadlineAt,
    );
    if (violation) throw violation;

    const turn = state.modelTurns + 1;
    const repairing = state.repairRequested;
    const offerTools =
      state.intent !== 'chitchat' &&
      ctx.tools.length > 0 &&
      state.toolCallCount < ctx.version.limits.maxToolCalls &&
      !repairing;
    const transcript: LlmMessage[] =
      state.transcript.length > 0
        ? state.transcript
        : initialTranscript(
            ctx.run.history,
            ctx.run.input,
            state.needsKnowledge || state.sources.length > 0 ? state.sources : null,
          );
    const step = await ctx.steps.start(
      'model_call',
      repairing ? `Repair answer` : `Model call ${turn}`,
      { tools: offerTools ? ctx.tools.map((t) => t.name) : [] },
    );

    let text = '';
    const calls: LlmToolCall[] = [];
    let stopReason: LlmStopReason = 'other';
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, estimated: true };
    let model = deps.llm.modelFor(ctx.version.modelProfile);
    try {
      const stream = deps.llm.streamTurn(
        {
          profile: ctx.version.modelProfile,
          purpose: repairing ? 'repair' : 'act',
          system: actSystemPrompt({
            agentName: ctx.agentName,
            projectName: ctx.project.name,
            projectDescription: ctx.project.description,
            instructions: ctx.version.instructions,
            plan: state.plan,
            outputSchema: ctx.version.outputSchema,
            toolNames: offerTools ? ctx.tools.map((t) => t.name) : [],
            dryRun: ctx.dryRun,
          }),
          messages: transcript,
          ...(offerTools
            ? { tools: ctx.tools.map((tool) => deps.registry.definitionFor(tool)) }
            : {}),
          maxTokens: 2_048,
          temperature: ctx.version.temperature,
        },
        ctx.signal,
      );
      for await (const event of stream) {
        if (event.type === 'text') {
          text += event.text;
          await ctx.emit({ type: 'message.delta', stepId: step.id, text: event.text });
        } else if (event.type === 'tool_call') {
          calls.push(event.call);
        } else {
          stopReason = event.stopReason;
          usage = event.usage;
          model = event.model;
        }
      }
    } catch (error) {
      await step.finish('failed', {
        summary: toRunError(error).message,
        error: toRunError(error),
        model,
      });
      throw error;
    }

    if (stopReason === 'refusal' && calls.length === 0 && !text.trim()) {
      text = "I can't help with that request.";
    }
    if (calls.length > 0 && text) await ctx.emit({ type: 'message.reset', stepId: step.id });
    await ctx.recordUsage({
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    });
    await step.finish('succeeded', {
      summary: calls.length
        ? `requested ${calls.map((c) => c.name).join(', ')}`
        : `answered · ${text.length} chars`,
      detail: {
        stopReason,
        toolCalls: calls.map((c) => ({ name: c.name, input: c.input })),
        text: truncate(text, 2_000),
        usageEstimated: usage.estimated,
      },
      model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    });

    const assistant: LlmMessage = {
      role: 'assistant',
      content: text,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
    return {
      transcript: [...transcript, assistant],
      pendingToolCalls: calls.map((call, index) => ({
        call,
        key: `${ctx.run.id}:${turn}:${index}`,
      })),
      finalText: calls.length ? state.finalText : text,
      lastStopReason: stopReason,
      repairRequested: false,
      modelTurns: turn,
      promptTokens: state.promptTokens + usage.inputTokens,
      completionTokens: state.completionTokens + usage.outputTokens,
    };
  }

  async tools(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    const transcript = [...state.transcript];
    let sources = state.sources;
    let toolCallCount = state.toolCallCount;
    const queue = [...state.pendingToolCalls];
    while (queue.length > 0) {
      await ctx.ensureActive();
      const pending = queue[0]!;
      if (toolCallCount >= ctx.version.limits.maxToolCalls) {
        // Keep the transcript valid (every tool call gets a result) and let the model wrap up.
        for (const rest of queue) {
          transcript.push({
            role: 'tool',
            toolCallId: rest.call.id,
            toolName: rest.call.name,
            content: JSON.stringify({
              error: 'TOOL_BUDGET_EXHAUSTED',
              message: 'This run has used all of its tool calls. Answer with what you have.',
            }),
            isError: true,
          });
        }
        queue.length = 0;
        break;
      }
      const outcome = await deps.toolExecution.execute(ctx, pending, sources);
      if (outcome.kind === 'needs_approval') {
        return {
          transcript,
          sources,
          toolCallCount,
          pendingToolCalls: queue,
          pendingApproval: {
            approvalId: outcome.approvalId,
            toolCallId: outcome.toolCallId,
            key: pending.key,
            stepId: outcome.stepId,
            requestedAt: outcome.requestedAt,
          },
        };
      }
      queue.shift();
      transcript.push(outcome.message);
      sources = outcome.sources;
      if (outcome.executed) toolCallCount += 1;
    }
    return { transcript, sources, toolCallCount, pendingToolCalls: [], pendingApproval: null };
  }

  /** Runs after the graph is resumed with a person's decision. */
  async applyApproval(
    state: RunGraphState,
    decision: ApprovalResume,
  ): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    const pendingApproval = state.pendingApproval;
    const pending = state.pendingToolCalls[0];
    if (!pendingApproval || !pending) return { pendingApproval: null };
    await ctx.steps.finishById(
      pendingApproval.stepId,
      new Date(pendingApproval.requestedAt),
      'approval_wait',
      decision.decision === 'approved' ? 'succeeded' : 'failed',
      `${decision.decision}${decision.comment ? `: "${truncate(decision.comment, 120)}"` : ''}`,
      { approvalId: decision.approvalId, decision: decision.decision },
    );
    await ctx.ensureActive();
    const outcome = await deps.toolExecution.afterDecision(ctx, pending, state.sources);
    return {
      transcript: [...state.transcript, outcome.message],
      sources: outcome.sources,
      toolCallCount: state.toolCallCount + (outcome.executed ? 1 : 0),
      pendingToolCalls: state.pendingToolCalls.slice(1),
      pendingApproval: null,
    };
  }

  async validate(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx, deps } = this;
    const step = await ctx.steps.start('validate', 'Validate answer');
    const checks: ValidationResult['checks'] = [];
    let text = state.finalText ?? '';
    if (!text.trim()) {
      const error = new RunStopped(
        'LLM_INVALID_OUTPUT',
        'The model returned an empty answer',
        'failed',
        true,
      );
      await step.finish('failed', { summary: error.message, error: toRunError(error) });
      throw error;
    }

    const known = new Set(state.sources.map((s) => s.index));
    const stripped = stripUnknownCitations(text, known);
    text = stripped.text;
    checks.push({
      name: 'citations_resolve',
      passed: stripped.removed.length === 0,
      detail: stripped.removed.length
        ? `Removed citations to sources that were never retrieved: ${stripped.removed.map((i) => `[${i}]`).join(', ')}`
        : 'Every citation points at a retrieved source',
    });

    const cited = citedIndices(text).filter((i) => known.has(i));
    if (state.intent === 'question' && state.sources.length > 0 && !ctx.version.outputSchema) {
      const admits = NO_ANSWER.test(text) || looksLikeRefusal(text);
      checks.push({
        name: 'grounded',
        passed: cited.length > 0 || admits,
        detail:
          cited.length > 0
            ? `Cites ${cited.length} source${cited.length === 1 ? '' : 's'}`
            : admits
              ? 'Says the sources do not answer it'
              : 'The answer cites none of the retrieved sources',
      });
    }

    const redacted = redactSecrets(text);
    text = redacted.text;
    checks.push({
      name: 'no_secrets',
      passed: redacted.found.length === 0,
      detail: redacted.found.length
        ? `Redacted credential-like strings: ${redacted.found.join(', ')}`
        : 'No credential-like strings',
    });

    if (state.lastStopReason === 'max_tokens') {
      checks.push({
        name: 'complete',
        passed: false,
        detail: 'The answer hit the output limit and may be cut off',
      });
    }

    let structured: unknown = null;
    const schema = ctx.version.outputSchema;
    if (schema) {
      let errors: string[] = [];
      try {
        structured = extractJson(text);
        const result = deps.validator.validate(schema, structured);
        if (!result.valid) errors = result.errors;
      } catch {
        errors = ['The answer is not valid JSON'];
      }
      checks.push({
        name: 'output_schema',
        passed: errors.length === 0,
        detail: errors.length ? errors.join('; ') : 'Matches the output schema',
      });
      if (errors.length > 0) {
        if (state.repairAttempts < 1) {
          await step.finish('failed', {
            summary: 'Output did not match the schema; asking the model to repair it',
            detail: { checks },
          });
          return {
            repairRequested: true,
            repairAttempts: state.repairAttempts + 1,
            transcript: [...state.transcript, { role: 'user', content: repairMessage(errors) }],
          };
        }
        const error = new RunStopped(
          'VALIDATION_FAILED',
          `The answer did not match the output schema: ${errors.slice(0, 3).join('; ')}`,
          'failed',
        );
        await step.finish('failed', {
          summary: error.message,
          detail: { checks },
          error: toRunError(error),
        });
        throw error;
      }
    }

    const repaired = checks.some(
      (c) => !c.passed && (c.name === 'citations_resolve' || c.name === 'no_secrets'),
    );
    const flagged = checks.some(
      (c) => !c.passed && (c.name === 'grounded' || c.name === 'complete'),
    );
    const validation: ValidationResult = {
      status: flagged ? 'flagged' : repaired ? 'repaired' : 'passed',
      checks,
    };
    const citations: Citation[] = cited.flatMap((index) => {
      const source = state.sources.find((s) => s.index === index);
      if (!source) return [];
      return [
        {
          index,
          chunkId: source.chunkId,
          documentId: source.documentId,
          documentTitle: source.documentTitle,
          snippet: truncate(source.content.replace(/\s+/g, ' '), 320),
          headingPath: source.headingPath,
          pageNumber: source.pageNumber,
        },
      ];
    });
    await step.finish('succeeded', {
      summary: `${validation.status} · ${checks.filter((c) => c.passed).length}/${checks.length} checks passed`,
      detail: { checks },
    });
    return {
      finalText: text,
      structuredOutput: structured,
      validation,
      citations,
      repairRequested: false,
    };
  }

  async refuse(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const { ctx } = this;
    const step = await ctx.steps.start('finalize', 'Decline request');
    const text = refusalText(state.intent, state.riskFlags);
    await ctx.emit({ type: 'message.delta', stepId: step.id, text });
    await step.finish('succeeded', {
      summary: `declined (${state.intent ?? 'unknown'})`,
      detail: { intent: state.intent, riskFlags: state.riskFlags },
    });
    return {
      finalText: text,
      refusal: true,
      validation: {
        status: 'passed',
        checks: [
          {
            name: 'policy_refusal',
            passed: true,
            detail: 'Declined by policy before any tool could run',
          },
        ],
      },
      citations: [],
    };
  }

  async finalize(state: RunGraphState): Promise<Partial<RunGraphState>> {
    const step = await this.ctx.steps.start('finalize', 'Finalize');
    await step.finish('succeeded', {
      summary: `${(state.finalText ?? '').length} chars · ${state.citations.length} citation${state.citations.length === 1 ? '' : 's'} · ${state.toolCallCount} tool call${state.toolCallCount === 1 ? '' : 's'}`,
    });
    return {};
  }
}
