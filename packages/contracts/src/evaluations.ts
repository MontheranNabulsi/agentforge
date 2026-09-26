import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';
import { ToolName } from './agents';

export const EVAL_CATEGORIES = [
  'rag_qa',
  'tool_selection',
  'hallucination_resistance',
  'structured_output',
  'refusal',
  'task_completion',
] as const;
export const EvalCategory = z.enum(EVAL_CATEGORIES);
export type EvalCategory = z.infer<typeof EvalCategory>;

/** What a case expects. Every field is optional; each present field becomes one evaluator. */
export const CaseExpectations = z.object({
  mustCallTools: z.array(ToolName).optional(),
  mustNotCallTools: z.array(ToolName).optional(),
  answerIncludes: z.array(z.string().min(1)).optional(),
  answerExcludes: z.array(z.string().min(1)).optional(),
  citesDocuments: z.array(z.string().min(1)).optional(),
  mustRefuse: z.boolean().optional(),
  approvalRequested: z.boolean().optional(),
  outputMatchesSchema: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
});
export type CaseExpectations = z.infer<typeof CaseExpectations>;

export const EvaluationCaseDto = z.object({
  id: Id,
  datasetId: Id,
  name: z.string(),
  category: EvalCategory,
  input: z.string(),
  expectations: CaseExpectations,
  tags: z.array(z.string()),
  createdAt: Timestamp,
});
export type EvaluationCaseDto = z.infer<typeof EvaluationCaseDto>;

export const CreateEvaluationCaseInput = z.object({
  name: z.string().trim().min(2).max(120),
  category: EvalCategory,
  input: z.string().trim().min(1).max(4_000),
  expectations: CaseExpectations,
  tags: z.array(z.string().max(40)).max(10).default([]),
});
export type CreateEvaluationCaseInput = z.infer<typeof CreateEvaluationCaseInput>;

export const EvaluationRunStatus = z.enum(['queued', 'running', 'completed', 'failed']);
export type EvaluationRunStatus = z.infer<typeof EvaluationRunStatus>;

export const EvaluationRunDto = z.object({
  id: Id,
  datasetId: Id,
  datasetName: z.string(),
  datasetRevision: z.number().int(),
  agentId: Id,
  agentName: z.string(),
  agentVersion: z.number().int(),
  status: EvaluationRunStatus,
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  gitSha: z.string().nullable(),
  totalCases: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  errored: z.number().int(),
  passRate: z.number().nullable(),
  regressions: z.number().int(),
  baselineRunId: Id.nullable(),
  triggeredBy: z.object({ id: Id, name: z.string() }).nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
});
export type EvaluationRunDto = z.infer<typeof EvaluationRunDto>;

export const EvaluatorResult = z.object({
  evaluator: z.string(),
  passed: z.boolean(),
  score: z.number(),
  reason: z.string(),
});
export type EvaluatorResult = z.infer<typeof EvaluatorResult>;

export const Verdict = z.enum(['passed', 'failed', 'error']);
export type Verdict = z.infer<typeof Verdict>;

export const EvaluationResultDto = z.object({
  id: Id,
  caseId: Id,
  caseName: z.string(),
  category: EvalCategory,
  input: z.string(),
  verdict: Verdict,
  score: z.number(),
  evaluatorResults: z.array(EvaluatorResult),
  agentRunId: Id.nullable(),
  output: z.string(),
  toolsCalled: z.array(z.string()),
  durationMs: z.number().int().nullable(),
  baselineVerdict: Verdict.nullable(),
  regression: z.boolean(),
});
export type EvaluationResultDto = z.infer<typeof EvaluationResultDto>;

export const EvaluationRunDetailDto = EvaluationRunDto.extend({
  results: z.array(EvaluationResultDto),
});
export type EvaluationRunDetailDto = z.infer<typeof EvaluationRunDetailDto>;

export const EvaluationDatasetDto = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  description: z.string(),
  revision: z.number().int(),
  caseCount: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastRun: EvaluationRunDto.nullable(),
});
export type EvaluationDatasetDto = z.infer<typeof EvaluationDatasetDto>;

export const CreateEvaluationDatasetInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
});
export type CreateEvaluationDatasetInput = z.infer<typeof CreateEvaluationDatasetInput>;

export const StartEvaluationRunInput = z.object({
  agentId: Id,
  baselineRunId: Id.optional(),
});
export type StartEvaluationRunInput = z.infer<typeof StartEvaluationRunInput>;

export const EvaluationRunListQuery = PageQuery.extend({ datasetId: Id.optional() });
export type EvaluationRunListQuery = z.infer<typeof EvaluationRunListQuery>;

export const EvaluationDatasetDetailDto = EvaluationDatasetDto.extend({
  cases: z.array(EvaluationCaseDto),
});
export type EvaluationDatasetDetailDto = z.infer<typeof EvaluationDatasetDetailDto>;
