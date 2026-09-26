import { z } from 'zod';
import { Id, Timestamp } from './common';
import { RiskLevel } from './approvals';
import { RunStatus, StepKind, StepStatus, ToolCallStatus } from './runs';

/**
 * Events a running agent emits. The worker appends them to a Redis Stream per run;
 * the API relays them to the browser as server-sent events, using the stream entry id
 * as the SSE event id so reconnecting clients resume exactly where they left off.
 */
export const RunEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.status'), runId: Id, status: RunStatus, at: Timestamp }),
  z.object({
    type: z.literal('step.started'),
    stepId: Id,
    seq: z.number().int(),
    kind: StepKind,
    name: z.string(),
    attempt: z.number().int(),
    at: Timestamp,
  }),
  z.object({
    type: z.literal('step.completed'),
    stepId: Id,
    seq: z.number().int(),
    kind: StepKind,
    status: StepStatus,
    summary: z.string(),
    durationMs: z.number().int(),
    at: Timestamp,
  }),
  z.object({
    type: z.literal('tool_call.started'),
    toolCallId: Id,
    toolName: z.string(),
    inputSummary: z.string(),
    at: Timestamp,
  }),
  z.object({
    type: z.literal('tool_call.completed'),
    toolCallId: Id,
    toolName: z.string(),
    status: ToolCallStatus,
    outputSummary: z.string(),
    durationMs: z.number().int().nullable(),
    at: Timestamp,
  }),
  z.object({
    type: z.literal('approval.requested'),
    approvalId: Id,
    toolCallId: Id,
    toolName: z.string(),
    title: z.string(),
    summary: z.string(),
    riskLevel: RiskLevel,
    at: Timestamp,
  }),
  z.object({
    type: z.literal('approval.decided'),
    approvalId: Id,
    decision: z.enum(['approved', 'rejected', 'expired']),
    at: Timestamp,
  }),
  z.object({ type: z.literal('message.delta'), stepId: Id, text: z.string() }),
  z.object({ type: z.literal('message.reset'), stepId: Id }),
  z.object({
    type: z.literal('run.completed'),
    runId: Id,
    messageId: Id.nullable(),
    at: Timestamp,
  }),
  z.object({
    type: z.literal('run.failed'),
    runId: Id,
    status: RunStatus,
    errorCode: z.string(),
    message: z.string(),
    at: Timestamp,
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['type'];
