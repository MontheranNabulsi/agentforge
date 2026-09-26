import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import type {
  AgentWorkflow,
  ApprovalResume,
  RunGraphState,
  WorkflowOutcome,
} from '../../application/ports';
import type { RunContext } from '../../application/run-context';
import {
  initialRunState,
  RunNodes,
  type NodeName,
  type RunNodeDeps,
} from '../../application/run-nodes';

/**
 * The LangGraph adapter: the ONLY place in the codebase that imports @langchain/*.
 *
 * It turns RunNodes (plain application code) into a checkpointed state graph:
 *
 *   START → classify ─┬─ refuse ─────────────────────────────┐
 *                     ├─ make_plan → retrieve? ─┐            │
 *                     ├─ retrieve ─────────┤                 │
 *                     └────────────────────┴→ act ⇄ tools ⇄ await_approval
 *                                              │                 │
 *                                              └→ validate ⇄ act (repair)
 *                                                  └→ finalize ←─┘ → END
 *
 * Checkpoints are written synchronously after every node (durability: "sync"), keyed by
 * thread_id = run id. A crashed worker's retry calls start() again and continues from the last
 * completed node; await_approval pauses the graph with interrupt() until resume().
 */

const lastValue = <T>(initial: () => T) =>
  Annotation<T>({ reducer: (_current: T, next: T) => next, default: initial });

const RunStateAnnotation = Annotation.Root({
  runId: lastValue<string>(() => ''),
  intent: lastValue<RunGraphState['intent']>(() => null),
  needsKnowledge: lastValue<boolean>(() => false),
  riskFlags: lastValue<string[]>(() => []),
  plan: lastValue<RunGraphState['plan']>(() => null),
  sources: lastValue<RunGraphState['sources']>(() => []),
  transcript: lastValue<RunGraphState['transcript']>(() => []),
  pendingToolCalls: lastValue<RunGraphState['pendingToolCalls']>(() => []),
  pendingApproval: lastValue<RunGraphState['pendingApproval']>(() => null),
  finalText: lastValue<string | null>(() => null),
  lastStopReason: lastValue<RunGraphState['lastStopReason']>(() => null),
  structuredOutput: lastValue<unknown>(() => null),
  refusal: lastValue<boolean>(() => false),
  repairRequested: lastValue<boolean>(() => false),
  validation: lastValue<RunGraphState['validation']>(() => null),
  citations: lastValue<RunGraphState['citations']>(() => []),
  repairAttempts: lastValue<number>(() => 0),
  modelTurns: lastValue<number>(() => 0),
  toolCallCount: lastValue<number>(() => 0),
  promptTokens: lastValue<number>(() => 0),
  completionTokens: lastValue<number>(() => 0),
});

type GraphState = typeof RunStateAnnotation.State;

export interface LangGraphWorkflowOptions {
  checkpointer: BaseCheckpointSaver & { deleteThread?(threadId: string): Promise<void> };
  nodeDeps: RunNodeDeps;
}

export class LangGraphAgentWorkflow implements AgentWorkflow<RunContext> {
  constructor(private readonly options: LangGraphWorkflowOptions) {}

  private build(ctx: RunContext) {
    const nodes = new RunNodes(this.options.nodeDeps, ctx);
    const as =
      (fn: (state: RunGraphState) => Promise<Partial<RunGraphState>>) => (state: GraphState) =>
        fn(state as RunGraphState) as Promise<Partial<GraphState>>;
    const route = (fn: (state: RunGraphState) => NodeName) => (state: GraphState) =>
      fn(state as RunGraphState);

    return new StateGraph(RunStateAnnotation)
      .addNode(
        'classify',
        as((s) => nodes.classify(s)),
      )
      .addNode(
        'make_plan',
        as((s) => nodes.plan(s)),
      )
      .addNode(
        'retrieve',
        as((s) => nodes.retrieve(s)),
      )
      .addNode(
        'act',
        as((s) => nodes.act(s)),
      )
      .addNode(
        'tools',
        as((s) => nodes.tools(s)),
      )
      .addNode(
        'await_approval',
        as(async (s) => {
          // First execution: interrupt() throws and the graph pauses here, checkpointed.
          // On resume: the node re-runs from the top and interrupt() returns the decision.
          const decision = interrupt<{ approvalId: string | undefined }, ApprovalResume>({
            approvalId: s.pendingApproval?.approvalId,
          });
          return nodes.applyApproval(s, decision);
        }),
      )
      .addNode(
        'validate',
        as((s) => nodes.validate(s)),
      )
      .addNode(
        'refuse',
        as((s) => nodes.refuse(s)),
      )
      .addNode(
        'finalize',
        as((s) => nodes.finalize(s)),
      )
      .addEdge(START, 'classify')
      .addConditionalEdges('classify', route(RunNodes.afterClassify), [
        'refuse',
        'act',
        'make_plan',
        'retrieve',
      ])
      .addConditionalEdges('make_plan', route(RunNodes.afterPlan), ['retrieve', 'act'])
      .addEdge('retrieve', 'act')
      .addConditionalEdges('act', route(RunNodes.afterAct), ['tools', 'validate'])
      .addConditionalEdges('tools', route(RunNodes.afterTools), ['await_approval', 'tools', 'act'])
      .addConditionalEdges('await_approval', route(RunNodes.afterApproval), ['tools', 'act'])
      .addConditionalEdges('validate', route(RunNodes.afterValidate), ['act', 'finalize'])
      .addEdge('refuse', 'finalize')
      .addEdge('finalize', END)
      .compile({ checkpointer: this.options.checkpointer });
  }

  private config(ctx: RunContext) {
    return {
      configurable: { thread_id: ctx.run.id },
      recursionLimit: 120,
      durability: 'sync' as const,
      signal: ctx.signal,
    };
  }

  async start(ctx: RunContext): Promise<WorkflowOutcome> {
    const graph = this.build(ctx);
    const config = this.config(ctx);
    const snapshot = await graph.getState({ configurable: { thread_id: ctx.run.id } });
    const hasCheckpoint =
      snapshot.values &&
      Object.keys(snapshot.values as object).length > 0 &&
      (snapshot.values as GraphState).runId;
    if (hasCheckpoint) {
      if (snapshot.tasks.some((task) => task.interrupts.length > 0))
        return this.outcome(graph, ctx);
      if (snapshot.next.length > 0) await graph.invoke(null, config); // crash recovery: continue from the last node
    } else {
      await graph.invoke(initialRunState(ctx.run.id), config);
    }
    return this.outcome(graph, ctx);
  }

  async resume(ctx: RunContext, decision: ApprovalResume): Promise<WorkflowOutcome> {
    const graph = this.build(ctx);
    const config = this.config(ctx);
    const snapshot = await graph.getState({ configurable: { thread_id: ctx.run.id } });
    if (snapshot.tasks.some((task) => task.interrupts.length > 0)) {
      await graph.invoke(new Command({ resume: decision }), config);
    } else if (snapshot.next.length > 0) {
      await graph.invoke(null, config); // a previous resume was interrupted after consuming the decision
    }
    return this.outcome(graph, ctx);
  }

  async discard(runId: string): Promise<void> {
    await this.options.checkpointer.deleteThread?.(runId);
  }

  private async outcome(
    graph: ReturnType<LangGraphAgentWorkflow['build']>,
    ctx: RunContext,
  ): Promise<WorkflowOutcome> {
    const snapshot = await graph.getState({ configurable: { thread_id: ctx.run.id } });
    const state = snapshot.values as RunGraphState;
    const paused = snapshot.tasks.some((task) => task.interrupts.length > 0);
    if (paused) {
      return { kind: 'interrupted', approvalId: state.pendingApproval?.approvalId ?? '', state };
    }
    if (snapshot.next.length > 0)
      throw new Error(`The run graph stopped early at ${snapshot.next.join(', ')}`);
    return { kind: 'completed', state };
  }
}
