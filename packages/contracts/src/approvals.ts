import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ApprovalDto = z.object({
  id: Id,
  organizationId: Id,
  projectId: Id,
  projectName: z.string(),
  runId: Id,
  toolCallId: Id,
  toolName: z.string(),
  riskLevel: RiskLevel,
  title: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
  policyReason: z.string(),
  status: ApprovalStatus,
  requestedBy: z.object({ id: Id, name: z.string() }).nullable(),
  requestedAt: Timestamp,
  expiresAt: Timestamp,
  decidedBy: z.object({ id: Id, name: z.string() }).nullable(),
  decidedAt: Timestamp.nullable(),
  decisionComment: z.string().nullable(),
});
export type ApprovalDto = z.infer<typeof ApprovalDto>;

export const DecideApprovalInput = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(1_000).optional(),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInput>;

export const ApprovalListQuery = PageQuery.extend({
  status: ApprovalStatus.optional(),
  projectId: Id.optional(),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;
