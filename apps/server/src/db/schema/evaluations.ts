import { desc, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { agentRuns, agentVersions, agents } from './agents';
import { createdAt, idColumn, sqlList, ts, updatedAt } from './columns';
import { users } from './identity';
import { projectTenantFk } from './projects';

export const evaluationDatasets = pgTable(
  'evaluation_datasets',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Bumped whenever a case changes; evaluation runs record which revision they used. */
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    projectTenantFk('evaluation_datasets_project_tenant_fk', t.projectId, t.organizationId),
    unique('evaluation_datasets_project_name_unique').on(t.projectId, t.name),
  ],
);

export const EVAL_CATEGORIES = [
  'rag_qa',
  'tool_selection',
  'hallucination_resistance',
  'structured_output',
  'refusal',
  'task_completion',
] as const;

export const evaluationCases = pgTable(
  'evaluation_cases',
  {
    id: idColumn(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evaluationDatasets.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    input: text('input').notNull(),
    expectations: jsonb('expectations').$type<Record<string, unknown>>().notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('evaluation_cases_dataset_name_unique').on(t.datasetId, t.name),
    check('evaluation_cases_category_check', sql.raw(`category IN ${sqlList(EVAL_CATEGORIES)}`)),
  ],
);

export const EVAL_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;

export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evaluationDatasets.id, { onDelete: 'cascade' }),
    datasetRevision: integer('dataset_revision').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    gitSha: text('git_sha'),
    totalCases: integer('total_cases').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    errored: integer('errored').notNull().default(0),
    regressions: integer('regressions').notNull().default(0),
    baselineRunId: uuid('baseline_run_id').references((): AnyPgColumn => evaluationRuns.id, {
      onDelete: 'set null',
    }),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    projectTenantFk('evaluation_runs_project_tenant_fk', t.projectId, t.organizationId),
    index('evaluation_runs_dataset_created_idx').on(t.datasetId, desc(t.createdAt)),
    check('evaluation_runs_status_check', sql.raw(`status IN ${sqlList(EVAL_RUN_STATUSES)}`)),
  ],
);

export const evaluationResults = pgTable(
  'evaluation_results',
  {
    id: idColumn(),
    evaluationRunId: uuid('evaluation_run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evaluationCases.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    verdict: text('verdict').notNull(),
    score: real('score').notNull(),
    evaluatorResults: jsonb('evaluator_results').$type<unknown[]>().notNull().default([]),
    output: text('output').notNull().default(''),
    toolsCalled: jsonb('tools_called').$type<string[]>().notNull().default([]),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('evaluation_results_run_case_unique').on(t.evaluationRunId, t.caseId),
    check('evaluation_results_verdict_check', sql.raw(`verdict IN ('passed', 'failed', 'error')`)),
  ],
);
