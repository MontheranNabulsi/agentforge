import { desc, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn, sqlList, ts, updatedAt } from './columns';
import { users } from './identity';
import { projectTenantFk } from './projects';

export const agents = pgTable(
  'agents',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isDefault: boolean('is_default').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    projectTenantFk('agents_project_tenant_fk', t.projectId, t.organizationId),
    unique('agents_project_slug_unique').on(t.projectId, t.slug),
    // Business rule enforced by the database: at most one default agent per project.
    uniqueIndex('agents_one_default_per_project')
      .on(t.projectId)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * Immutable configuration snapshots. Editing an agent inserts version n+1; every run
 * points at the exact version that produced it, which makes evaluation comparisons honest.
 * The current version is simply the highest version number.
 */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: idColumn(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    version: integer('version').notNull(),
    instructions: text('instructions').notNull(),
    modelProfile: text('model_profile').notNull(),
    temperature: real('temperature').notNull(),
    tools: jsonb('tools').$type<unknown[]>().notNull(),
    limits: jsonb('limits').$type<Record<string, number>>().notNull(),
    retrieval: jsonb('retrieval').$type<Record<string, number>>().notNull(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    promptVersion: text('prompt_version').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    projectTenantFk('agent_versions_project_tenant_fk', t.projectId, t.organizationId),
    unique('agent_versions_agent_version_unique').on(t.agentId, t.version),
    check('agent_versions_model_profile_check', sql.raw(`model_profile IN ('fast', 'default')`)),
  ],
);

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const RUN_TRIGGERS = ['chat', 'evaluation'] as const;

/**
 * One execution of one agent version. Runs know nothing about conversations or evaluations:
 * the channel that started a run is recorded as (trigger, trigger_ref_id) without a foreign key,
 * and channels point back at runs from their own tables.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    triggerRefId: uuid('trigger_ref_id'),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    input: text('input').notNull(),
    history: jsonb('history').$type<{ role: string; content: string }[]>().notNull().default([]),
    status: text('status').notNull().default('queued'),
    intent: text('intent'),
    plan: jsonb('plan'),
    output: jsonb('output'),
    error: jsonb('error'),
    provider: text('provider'),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    stepCount: integer('step_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    deadlineAt: ts('deadline_at'),
    cancelRequestedAt: ts('cancel_requested_at'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    projectTenantFk('agent_runs_project_tenant_fk', t.projectId, t.organizationId),
    index('agent_runs_project_created_idx').on(t.projectId, desc(t.createdAt)),
    index('agent_runs_agent_created_idx').on(t.agentId, desc(t.createdAt)),
    index('agent_runs_active_idx')
      .on(t.organizationId, t.status)
      .where(sql`${t.status} IN ('queued', 'running', 'awaiting_approval')`),
    // Business rule enforced by the database: one run in flight per conversation.
    uniqueIndex('agent_runs_one_active_per_conversation')
      .on(t.triggerRefId)
      .where(
        sql`${t.trigger} = 'chat' AND ${t.status} IN ('queued', 'running', 'awaiting_approval')`,
      ),
    check('agent_runs_status_check', sql.raw(`status IN ${sqlList(RUN_STATUSES)}`)),
    check('agent_runs_trigger_check', sql.raw(`trigger IN ${sqlList(RUN_TRIGGERS)}`)),
  ],
);

export const STEP_KINDS = [
  'classify',
  'plan',
  'retrieve',
  'model_call',
  'tool_call',
  'approval_wait',
  'validate',
  'finalize',
] as const;
export const STEP_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;

export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: idColumn(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    durationMs: integer('duration_ms'),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    summary: text('summary').notNull().default(''),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    error: jsonb('error'),
  },
  (t) => [
    unique('agent_run_steps_run_seq_unique').on(t.runId, t.seq),
    check('agent_run_steps_kind_check', sql.raw(`kind IN ${sqlList(STEP_KINDS)}`)),
    check('agent_run_steps_status_check', sql.raw(`status IN ${sqlList(STEP_STATUSES)}`)),
  ],
);

export const TOOL_CALL_STATUSES = [
  'proposed',
  'awaiting_approval',
  'approved',
  'denied',
  'executing',
  'succeeded',
  'failed',
  'timed_out',
] as const;

/** Tool calls have their own lifecycle and are queried directly, so they get a table. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: idColumn(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => agentRunSteps.id, { onDelete: 'set null' }),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    toolName: text('tool_name').notNull(),
    providerCallId: text('provider_call_id'),
    /** runId:turn:index — lets side-effecting tools refuse to run twice. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    inputSummary: text('input_summary').notNull().default(''),
    output: jsonb('output'),
    outputSummary: text('output_summary'),
    error: jsonb('error'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    index('tool_calls_run_idx').on(t.runId),
    index('tool_calls_project_tool_idx').on(t.projectId, t.toolName),
    check('tool_calls_status_check', sql.raw(`status IN ${sqlList(TOOL_CALL_STATUSES)}`)),
  ],
);

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * A generic "a person must decide" record. subject_type names what is being approved;
 * the subject columns form an exclusive arc (exactly the column matching subject_type is set).
 * Tool calls are the only subject today.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull().default('tool_call'),
    toolCallId: uuid('tool_call_id')
      .unique()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    riskLevel: text('risk_level').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    policyReason: text('policy_reason').notNull(),
    approverRoles: jsonb('approver_roles').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionComment: text('decision_comment'),
  },
  (t) => [
    projectTenantFk('approval_requests_project_tenant_fk', t.projectId, t.organizationId),
    index('approval_requests_pending_idx')
      .on(t.organizationId, desc(t.requestedAt))
      .where(sql`${t.status} = 'pending'`),
    index('approval_requests_project_idx').on(t.projectId, desc(t.requestedAt)),
    check(
      'approval_requests_subject_arc',
      sql`(${t.subjectType} = 'tool_call') = (${t.toolCallId} IS NOT NULL)`,
    ),
    check('approval_requests_status_check', sql.raw(`status IN ${sqlList(APPROVAL_STATUSES)}`)),
    check('approval_requests_risk_check', sql.raw(`risk_level IN ${sqlList(RISK_LEVELS)}`)),
  ],
);
