import type {
  AgentLimits,
  Citation,
  Page,
  Plan,
  RetrievalSettings,
  RunError,
  RunEvent,
  RunOutput,
  RunTrigger,
  ToolCallStatus,
  ToolGrant,
  ValidationResult,
} from '@agentforge/contracts';
import type {
  LlmMessage,
  LlmStopReason,
  LlmToolCall,
  ModelProfile,
} from '../../../shared-kernel/ai';
import type { RiskLevel, Role } from '../domain/approval-policy';
import type { RunIntent, RunStatus } from '../domain/run-rules';
import type { ProjectQueryInput, SourceChunk, SourceRef } from './shared-types';

export type { SourceRef } from './shared-types';

// ---------------------------------------------------------------------------------------
// Agents and immutable versions
// ---------------------------------------------------------------------------------------

export interface AgentRecord {
  id: string;
  organizationId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  version: number;
  instructions: string;
  modelProfile: ModelProfile;
  temperature: number;
  tools: ToolGrant[];
  limits: AgentLimits;
  retrieval: RetrievalSettings;
  outputSchema: Record<string, unknown> | null;
  promptVersion: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

export type AgentWithVersion = AgentRecord & { currentVersion: AgentVersionRecord };

export interface AgentRepository {
  /** Inserts the agent and its version 1 together. */
  create(agent: AgentRecord, version: Omit<AgentVersionRecord, 'createdByName'>): Promise<void>;
  findById(id: string): Promise<AgentWithVersion | null>;
  findDefault(projectId: string): Promise<AgentWithVersion | null>;
  list(projectId: string): Promise<AgentWithVersion[]>;
  slugExists(projectId: string, slug: string): Promise<boolean>;
  /** Unique (agent_id, version): a concurrent edit that picked the same number fails. */
  addVersion(version: Omit<AgentVersionRecord, 'createdByName'>): Promise<void>;
  update(
    id: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'description' | 'isDefault' | 'archivedAt'>>,
    now: Date,
  ): Promise<void>;
  clearDefault(projectId: string): Promise<void>;
  listVersions(agentId: string): Promise<AgentVersionRecord[]>;
  findVersion(versionId: string): Promise<AgentVersionRecord | null>;
}

// ---------------------------------------------------------------------------------------
// Runs, steps, tool calls, approvals
// ---------------------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  organizationId: string;
  projectId: string;
  agentId: string;
  agentName: string;
  agentVersionId: string;
  agentVersion: number;
  trigger: RunTrigger;
  triggerRefId: string | null;
  triggeredBy: string | null;
  input: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  status: RunStatus;
  intent: RunIntent | null;
  plan: Plan | null;
  output: RunOutput | null;
  error: RunError | null;
  provider: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  stepCount: number;
  toolCallCount: number;
  requestId: string | null;
  traceId: string | null;
  deadlineAt: Date | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export type NewRun = Omit<RunRecord, 'agentName' | 'agentVersion' | 'updatedAt'>;

export interface RunListFilter {
  projectId: string;
  limit: number;
  cursor?: string;
  status?: RunStatus;
  agentId?: string;
  trigger?: RunTrigger;
}

export type StepKind =
  | 'classify'
  | 'plan'
  | 'retrieve'
  | 'model_call'
  | 'tool_call'
  | 'approval_wait'
  | 'validate'
  | 'finalize';
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StepRecord {
  id: string;
  runId: string;
  organizationId: string;
  seq: number;
  kind: StepKind;
  name: string;
  status: StepStatus;
  attempt: number;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  summary: string;
  detail: Record<string, unknown>;
  error: RunError | null;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  stepId: string | null;
  organizationId: string;
  projectId: string;
  toolName: string;
  providerCallId: string | null;
  idempotencyKey: string;
  status: ToolCallStatus;
  input: Record<string, unknown>;
  inputSummary: string;
  output: unknown;
  outputSummary: string | null;
  error: RunError | null;
  attempt: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  approvalId?: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalRecord {
  id: string;
  organizationId: string;
  projectId: string;
  projectName?: string;
  runId: string;
  toolCallId: string;
  toolName?: string;
  riskLevel: RiskLevel;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  policyReason: string;
  approverRoles: string[];
  status: ApprovalStatus;
  requestedBy: string | null;
  requestedByName?: string | null;
  requestedAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedByName?: string | null;
  decidedAt: Date | null;
  decisionComment: string | null;
}

export interface RunRepository {
  /** Throws a RUN_IN_PROGRESS conflict when the channel already has an active run. */
  create(run: NewRun): Promise<void>;
  findById(id: string): Promise<RunRecord | null>;
  list(filter: RunListFilter): Promise<Page<RunRecord>>;
  countActive(organizationId: string): Promise<number>;
  tokensUsedSince(organizationId: string, since: Date): Promise<number>;
  /** Conditional update: only applies when the current status is one of `from`. Returns whether it applied. */
  transition(
    id: string,
    from: readonly RunStatus[],
    to: RunStatus,
    patch: Partial<RunRecord>,
    now: Date,
  ): Promise<boolean>;
  update(id: string, patch: Partial<RunRecord>, now: Date): Promise<void>;
  addUsage(id: string, usage: { promptTokens: number; completionTokens: number }): Promise<void>;
  findStale(params: { queuedBefore: Date; now: Date; limit: number }): Promise<RunRecord[]>;
  latestForTrigger(trigger: RunTrigger, triggerRefId: string): Promise<RunRecord | null>;
  activeForTrigger(trigger: RunTrigger, triggerRefIds: string[]): Promise<Map<string, string>>;
}

export interface StepRepository {
  nextSeq(runId: string): Promise<number>;
  insert(step: StepRecord): Promise<void>;
  finish(id: string, patch: Partial<StepRecord>): Promise<void>;
  list(runId: string): Promise<StepRecord[]>;
}

export interface ToolCallRepository {
  findByKey(idempotencyKey: string): Promise<ToolCallRecord | null>;
  findById(id: string): Promise<ToolCallRecord | null>;
  insert(call: ToolCallRecord): Promise<void>;
  update(id: string, patch: Partial<ToolCallRecord>): Promise<void>;
  list(runId: string): Promise<ToolCallRecord[]>;
}

export interface ApprovalRepository {
  insert(approval: ApprovalRecord): Promise<void>;
  findById(id: string): Promise<ApprovalRecord | null>;
  findByToolCall(toolCallId: string): Promise<ApprovalRecord | null>;
  /** Conditional: only a pending request can be decided, so two clicks produce one decision. */
  decide(
    id: string,
    decision: {
      status: 'approved' | 'rejected' | 'expired' | 'cancelled';
      by: string | null;
      comment: string | null;
    },
    now: Date,
  ): Promise<boolean>;
  list(filter: {
    organizationId: string;
    projectId?: string;
    status?: ApprovalStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<ApprovalRecord>>;
  findExpiredPending(now: Date, limit: number): Promise<ApprovalRecord[]>;
  pendingForRun(runId: string): Promise<ApprovalRecord[]>;
}

// ---------------------------------------------------------------------------------------
// Streaming run events (Redis Streams in production)
// ---------------------------------------------------------------------------------------

export interface RunEventPublisher {
  publish(runId: string, event: RunEvent): Promise<void>;
  /** Called when a run reaches a terminal state: the stream expires a while later. */
  expireLater(runId: string): Promise<void>;
}

export interface RunEventReader {
  read(
    runId: string,
    afterId: string | null,
    blockMs: number,
  ): Promise<{ id: string; event: RunEvent }[]>;
}

// ---------------------------------------------------------------------------------------
// Gateways to the rest of the system. Implemented outside this module (knowledge, insights,
// platform) and injected by the composition root, so agents never reach into their tables.
// ---------------------------------------------------------------------------------------

export interface KnowledgeGateway {
  retrieve(projectId: string, query: string, limit: number): Promise<SourceChunk[]>;
  lookup(
    projectId: string,
    titleOrId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    chunkCount: number;
    preview: SourceChunk[];
  } | null>;
  createNote(params: {
    organizationId: string;
    projectId: string;
    title: string;
    content: string;
    agent: { id: string; name: string };
    onBehalfOfUserId: string;
    runId: string;
    idempotencyKey: string;
  }): Promise<{ documentId: string; title: string }>;
}

export interface ProjectDataGateway {
  metadata(projectId: string): Promise<{
    name: string;
    description: string;
    documentCount: number;
    agentCount: number;
    memberCount: number;
    createdAt: string;
  }>;
  query(projectId: string, query: ProjectQueryInput): Promise<unknown>;
}

export interface HttpGateway {
  request(
    req: { method: string; url: string; body?: unknown },
    policy: { allowedHosts: string[]; allowWrite: boolean },
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown; truncated: boolean; url: string }>;
}

/** Answers "may this user do X in this organization?" without agents importing the RBAC matrix. */
export interface MemberPermissions {
  roleOf(userId: string, organizationId: string): Promise<Role | null>;
  allows(role: Role, permission: string): boolean;
}

export interface ProjectLookup {
  load(
    projectId: string,
  ): Promise<{ id: string; organizationId: string; name: string; description: string }>;
}

export interface OutputSchemaValidator {
  validate(schema: Record<string, unknown>, value: unknown): { valid: boolean; errors: string[] };
  /** Rejects schemas that cannot be compiled (checked when an agent is saved). */
  check(schema: Record<string, unknown>): string | null;
}

// ---------------------------------------------------------------------------------------
// The workflow port: the orchestrator doesn't know LangGraph exists.
// ---------------------------------------------------------------------------------------

export interface ApprovalResume {
  approvalId: string;
  toolCallId: string;
  decision: 'approved' | 'rejected' | 'expired';
  comment: string | null;
}

export interface PendingToolCall {
  call: LlmToolCall;
  /** runId:turn:index — stable across retries, so a replayed call reuses its stored result. */
  key: string;
}

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  key: string;
  stepId: string;
  requestedAt: string;
}

/** Everything the graph carries between nodes; checkpointed after every node. */
export interface RunGraphState {
  runId: string;
  intent: RunIntent | null;
  needsKnowledge: boolean;
  riskFlags: string[];
  plan: Plan | null;
  sources: SourceRef[];
  transcript: LlmMessage[];
  pendingToolCalls: PendingToolCall[];
  pendingApproval: PendingApproval | null;
  finalText: string | null;
  lastStopReason: LlmStopReason | null;
  structuredOutput: unknown;
  refusal: boolean;
  repairRequested: boolean;
  validation: ValidationResult | null;
  citations: Citation[];
  repairAttempts: number;
  modelTurns: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
}

export type WorkflowOutcome =
  | { kind: 'completed'; state: RunGraphState }
  | { kind: 'interrupted'; approvalId: string; state: RunGraphState };

export interface AgentWorkflow<TContext> {
  /** Starts a fresh run, or continues one from its last checkpoint after a crash. */
  start(ctx: TContext): Promise<WorkflowOutcome>;
  /** Continues a run paused for approval (or re-continues it if a resume was interrupted). */
  resume(ctx: TContext, decision: ApprovalResume): Promise<WorkflowOutcome>;
  /** Forget a run's checkpoints (after it is terminal). */
  discard(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Channels: conversations and evaluations start runs and receive their results.
// ---------------------------------------------------------------------------------------

export interface RunCompletion {
  run: RunRecord;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  output: RunOutput | null;
  error: RunError | null;
}

/**
 * Implemented by the modules that start runs. Agents never import conversations or
 * evaluations; the composition root registers one handler per trigger.
 */
export interface RunCompletionHandler {
  /** Runs inside the transaction that records the run's terminal state. Returns a message id, if any. */
  onRunFinished(completion: RunCompletion): Promise<{ messageId: string | null }>;
}

export type RunCompletionHandlers = Partial<Record<RunTrigger, RunCompletionHandler>>;
