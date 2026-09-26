/**
 * What happened, who did it, to what. Actions are dotted "noun.verb" names so they can be
 * filtered by prefix ("approval." shows every approval event).
 */
export type AuditAction =
  | 'organization.created'
  | 'member.added'
  | 'member.role_changed'
  | 'member.removed'
  | 'project.created'
  | 'project.updated'
  | 'project.archived'
  | 'project.restored'
  | 'document.uploaded'
  | 'document.deleted'
  | 'document.reindexed'
  | 'note.created'
  | 'agent.created'
  | 'agent.updated'
  | 'run.started'
  | 'run.cancelled'
  | 'tool.executed'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.expired'
  | 'evaluation.started'
  | 'evaluation.completed';

export type AuditActor =
  | { type: 'user'; id: string; name?: string }
  | { type: 'agent'; id: string; name?: string; onBehalfOfUserId: string }
  | { type: 'system'; name?: string };

export interface AuditEntry {
  organizationId: string;
  projectId?: string | null;
  actor: AuditActor;
  action: AuditAction;
  target: { type: string; id?: string | null };
  metadata?: Record<string, unknown>;
  runId?: string | null;
}
