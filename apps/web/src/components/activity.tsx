import type { AuditEventDto } from '@agentforge/contracts';
import { Bot, Cog, User } from 'lucide-react';
import { timeAgo } from '@/lib/format';

const VERBS: Record<string, string> = {
  'organization.created': 'created the organization',
  'member.added': 'added a member',
  'member.role_changed': 'changed a member’s role',
  'member.removed': 'removed a member',
  'project.created': 'created project',
  'project.updated': 'updated project',
  'project.archived': 'archived project',
  'project.restored': 'restored project',
  'document.uploaded': 'uploaded',
  'document.deleted': 'deleted',
  'document.reindexed': 're-indexed',
  'note.created': 'saved a note',
  'agent.created': 'created agent',
  'agent.updated': 'updated agent',
  'run.started': 'started a run',
  'run.cancelled': 'cancelled a run',
  'tool.executed': 'ran tool',
  'approval.requested': 'requested approval for',
  'approval.approved': 'approved',
  'approval.rejected': 'rejected',
  'approval.expired': 'let expire',
  'evaluation.started': 'started an evaluation',
  'evaluation.completed': 'finished an evaluation',
};

function detail(event: AuditEventDto): string {
  const m = event.metadata as Record<string, unknown>;
  if (typeof m.title === 'string') return `“${m.title}”`;
  if (typeof m.name === 'string') return m.name;
  if (typeof m.tool === 'string') return m.tool;
  if (typeof m.dataset === 'string') return m.dataset;
  return '';
}

export function ActivityList({
  events,
  empty = 'No activity yet',
}: {
  events: AuditEventDto[];
  empty?: string;
}) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3">
      {events.map((event) => {
        const Icon = event.actorType === 'agent' ? Bot : event.actorType === 'system' ? Cog : User;
        return (
          <li key={event.id} className="flex gap-3 text-sm">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0">
              <p className="leading-snug">
                <span className="font-medium">
                  {event.actorName ??
                    (event.actorType === 'system'
                      ? 'System'
                      : event.actorType === 'agent'
                        ? 'An agent'
                        : 'A teammate')}
                </span>{' '}
                <span className="text-muted-foreground">{VERBS[event.action] ?? event.action}</span>{' '}
                <span>{detail(event)}</span>
              </p>
              <p className="text-xs text-muted-foreground">{timeAgo(event.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
