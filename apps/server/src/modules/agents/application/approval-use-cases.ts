import type { ApprovalDto, Page } from '@agentforge/contracts';
import { conflict, forbidden, notFound } from '../../../shared-kernel/errors';
import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import type { AuditLog } from '../../audit';
import type { OrganizationAccess } from '../../organizations';
import type { ProjectAccess } from '../../projects';
import { mayApprove, type Role } from '../domain/approval-policy';
import type {
  ApprovalRecord,
  ApprovalRepository,
  ApprovalStatus,
  RunEventPublisher,
  ToolCallRepository,
} from './ports';

type NamedActor = Actor & { name?: string };

export const toApprovalDto = (a: ApprovalRecord): ApprovalDto => ({
  id: a.id,
  organizationId: a.organizationId,
  projectId: a.projectId,
  projectName: a.projectName ?? '',
  runId: a.runId,
  toolCallId: a.toolCallId,
  toolName: a.toolName ?? '',
  riskLevel: a.riskLevel,
  title: a.title,
  summary: a.summary,
  payload: a.payload,
  policyReason: a.policyReason,
  status: a.status,
  requestedBy: a.requestedBy ? { id: a.requestedBy, name: a.requestedByName ?? 'Unknown' } : null,
  requestedAt: a.requestedAt.toISOString(),
  expiresAt: a.expiresAt.toISOString(),
  decidedBy: a.decidedBy ? { id: a.decidedBy, name: a.decidedByName ?? 'Unknown' } : null,
  decidedAt: a.decidedAt?.toISOString() ?? null,
  decisionComment: a.decisionComment,
});

export interface ApprovalUseCaseDeps {
  approvals: ApprovalRepository;
  toolCalls: ToolCallRepository;
  organizationAccess: OrganizationAccess;
  projectAccess: ProjectAccess;
  events: RunEventPublisher;
  jobs: BackgroundJobs;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
}

/**
 * Human-in-the-loop decisions. Deciding is a conditional update on a pending row, so a
 * double click, two approvers or a decision racing the expiry sweep all produce exactly one
 * outcome. The decision and the job that resumes the run commit in the same transaction.
 */
export class ApprovalUseCases {
  constructor(private readonly deps: ApprovalUseCaseDeps) {}

  async list(
    actor: Actor,
    organizationId: string,
    filter: { status?: ApprovalStatus; projectId?: string; limit: number; cursor?: string },
  ): Promise<Page<ApprovalRecord>> {
    await this.deps.organizationAccess.require(actor, organizationId, 'approval:read');
    return this.deps.approvals.list({ organizationId, ...filter });
  }

  async get(actor: Actor, approvalId: string): Promise<ApprovalRecord> {
    const approval = await this.deps.approvals.findById(approvalId);
    if (!approval) throw notFound('APPROVAL_NOT_FOUND', 'Approval not found');
    await this.deps.projectAccess.require(actor, approval.projectId, 'approval:read');
    return approval;
  }

  async decide(
    actor: NamedActor,
    approvalId: string,
    input: { decision: 'approve' | 'reject'; comment?: string | undefined },
  ): Promise<ApprovalRecord> {
    const { approvals, toolCalls, projectAccess, tx, clock, jobs, audit, events } = this.deps;
    const approval = await approvals.findById(approvalId);
    if (!approval) throw notFound('APPROVAL_NOT_FOUND', 'Approval not found');
    const { role } = await projectAccess.require(actor, approval.projectId, 'approval:decide');
    if (!mayApprove(role as Role, { approverRoles: approval.approverRoles as Role[] })) {
      throw forbidden(
        'APPROVER_ROLE_REQUIRED',
        `Only ${approval.approverRoles.join(' or ')} can decide this ${approval.riskLevel}-risk action`,
      );
    }
    if (approval.status !== 'pending') {
      throw conflict('APPROVAL_ALREADY_DECIDED', `This request was already ${approval.status}`, {
        status: approval.status,
      });
    }
    const now = clock.now();
    if (approval.expiresAt.getTime() <= now.getTime()) {
      await this.expire(approval);
      throw conflict('APPROVAL_EXPIRED', 'This request expired before it was decided');
    }

    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const comment = input.comment?.trim() || null;
    await tx.run(async () => {
      const applied = await approvals.decide(
        approval.id,
        { status, by: actor.userId, comment },
        now,
      );
      if (!applied) throw conflict('APPROVAL_ALREADY_DECIDED', 'This request was already decided');
      if (status === 'approved') {
        await toolCalls.update(approval.toolCallId, { status: 'approved' });
      } else {
        await toolCalls.update(approval.toolCallId, {
          status: 'denied',
          output: {
            status: 'rejected',
            denied: true,
            comment,
            message: 'A person rejected this action. Do not retry it; tell the user.',
          },
          outputSummary: 'rejected by approver',
          endedAt: now,
        });
      }
      await audit.record({
        organizationId: approval.organizationId,
        projectId: approval.projectId,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: status === 'approved' ? 'approval.approved' : 'approval.rejected',
        target: { type: 'approval', id: approval.id },
        metadata: { tool: approval.toolName, riskLevel: approval.riskLevel, comment },
        runId: approval.runId,
      });
      await jobs.enqueue(
        'agent-run.resume',
        { runId: approval.runId, approvalId: approval.id },
        { dedupeKey: `resume-${approval.id}` },
      );
    });
    await events
      .publish(approval.runId, {
        type: 'approval.decided',
        approvalId: approval.id,
        decision: status,
        at: now.toISOString(),
      })
      .catch(() => undefined);
    return (await approvals.findById(approval.id))!;
  }

  /** Maintenance: pending requests past their expiry resume the run as "expired". */
  async expireOverdue(limit = 50): Promise<number> {
    const overdue = await this.deps.approvals.findExpiredPending(this.deps.clock.now(), limit);
    let count = 0;
    for (const approval of overdue) {
      if (await this.expire(approval)) count += 1;
    }
    return count;
  }

  private async expire(approval: ApprovalRecord): Promise<boolean> {
    const { approvals, toolCalls, tx, clock, jobs, audit, events } = this.deps;
    const now = clock.now();
    const applied = await tx.run(async () => {
      const ok = await approvals.decide(
        approval.id,
        { status: 'expired', by: null, comment: 'Expired without a decision' },
        now,
      );
      if (!ok) return false;
      await toolCalls.update(approval.toolCallId, {
        status: 'denied',
        output: {
          status: 'expired',
          denied: true,
          message: 'Nobody approved this action in time, so it was not performed. Tell the user.',
        },
        outputSummary: 'approval expired',
        endedAt: now,
      });
      await audit.record({
        organizationId: approval.organizationId,
        projectId: approval.projectId,
        actor: { type: 'system', name: 'approval-expiry' },
        action: 'approval.expired',
        target: { type: 'approval', id: approval.id },
        runId: approval.runId,
      });
      await jobs.enqueue(
        'agent-run.resume',
        { runId: approval.runId, approvalId: approval.id },
        { dedupeKey: `resume-${approval.id}` },
      );
      return true;
    });
    if (applied) {
      await events
        .publish(approval.runId, {
          type: 'approval.decided',
          approvalId: approval.id,
          decision: 'expired',
          at: now.toISOString(),
        })
        .catch(() => undefined);
    }
    return applied;
  }
}
