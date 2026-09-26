import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';
import { ToolName } from './agents';

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'awaiting_approval'] as const;

export const RunTrigger = z.enum(['chat', 'evaluation']);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const RunIntent = z.enum(['question', 'task', 'chitchat', 'out_of_scope', 'unsafe']);
export type RunIntent = z.infer<typeof RunIntent>;

export const StepKind = z.enum([
  'classify',
  'plan',
  'retrieve',
  'model_call',
  'tool_call',
  'approval_wait',
  'validate',
  'finalize',
]);
export type StepKind = z.infer<typeof StepKind>;

export const StepStatus = z.enum(['running', 'succeeded', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

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
export const ToolCallStatus = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const Citation = z.object({
  index: z.number().int(),
  chunkId: Id,
  documentId: Id,
  documentTitle: z.string(),
  snippet: z.string(),
  headingPath: z.string(),
  pageNumber: z.number().int().nullable(),
});
export type Citation = z.infer<typeof Citation>;

export const ValidationCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export const ValidationResult = z.object({
  status: z.enum(['passed', 'repaired', 'flagged', 'failed']),
  checks: z.array(ValidationCheck),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

export const PlanStep = z.object({
  id: z.string(),
  description: z.string(),
  tool: ToolName.nullable(),
});
export const Plan = z.object({
  goal: z.string(),
  steps: z.array(PlanStep),
});
export type Plan = z.infer<typeof Plan>;

export const RunError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type RunError = z.infer<typeof RunError>;

export const RunSummaryDto = z.object({
  id: Id,
  projectId: Id,
  agentId: Id,
  agentName: z.string(),
  agentVersion: z.number().int(),
  trigger: RunTrigger,
  triggerRefId: Id.nullable(),
  status: RunStatus,
  intent: RunIntent.nullable(),
  inputPreview: z.string(),
  errorCode: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  stepCount: z.number().int(),
  toolCallCount: z.number().int(),
  durationMs: z.number().int().nullable(),
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
});
export type RunSummaryDto = z.infer<typeof RunSummaryDto>;

export const StepDto = z.object({
  id: Id,
  seq: z.number().int(),
  kind: StepKind,
  name: z.string(),
  status: StepStatus,
  attempt: z.number().int(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  durationMs: z.number().int().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()),
  error: RunError.nullable(),
});
export type StepDto = z.infer<typeof StepDto>;

export const ToolCallDto = z.object({
  id: Id,
  stepId: Id.nullable(),
  toolName: ToolName,
  status: ToolCallStatus,
  input: z.record(z.string(), z.unknown()),
  inputSummary: z.string(),
  output: z.unknown().nullable(),
  outputSummary: z.string().nullable(),
  error: RunError.nullable(),
  attempt: z.number().int(),
  durationMs: z.number().int().nullable(),
  approvalId: Id.nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});
export type ToolCallDto = z.infer<typeof ToolCallDto>;

export const RunOutput = z.object({
  text: z.string(),
  structured: z.unknown().nullable(),
  citations: z.array(Citation),
  validation: ValidationResult.nullable(),
});
export type RunOutput = z.infer<typeof RunOutput>;

export const RunDetailDto = RunSummaryDto.extend({
  input: z.string(),
  plan: Plan.nullable(),
  output: RunOutput.nullable(),
  error: RunError.nullable(),
  deadlineAt: Timestamp.nullable(),
  agentConfig: z.object({
    versionId: Id,
    modelProfile: z.string(),
    tools: z.array(z.string()),
    promptVersion: z.string(),
  }),
  steps: z.array(StepDto),
  toolCalls: z.array(ToolCallDto),
});
export type RunDetailDto = z.infer<typeof RunDetailDto>;

export const RunListQuery = PageQuery.extend({
  status: RunStatus.optional(),
  agentId: Id.optional(),
  trigger: RunTrigger.optional(),
});
export type RunListQuery = z.infer<typeof RunListQuery>;
