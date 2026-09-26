'use client';

import {
  Bot,
  FileText,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { ErrorBox, Skeleton } from '@/components/ui/misc';
import { useCurrentOrg, useProject } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '', label: 'Overview', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/documents', label: 'Knowledge', icon: FileText },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/runs', label: 'Runs', icon: ListChecks },
  { href: '/evaluations', label: 'Evaluations', icon: FlaskConical },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const pathname = usePathname();
  const project = useProject(projectId);
  const { org, role } = useCurrentOrg();
  const base = `/p/${projectId}`;
  const inChat = pathname.startsWith(`${base}/chat/`);

  if (project.isError) return <ErrorBox error={project.error} />;

  return (
    <div className={cn(inChat && 'flex h-[calc(100vh-4rem)] flex-col lg:h-[calc(100vh-4rem)]')}>
      <div className="mb-5">
        <div className="text-xs text-muted-foreground">
          {org ? (
            <Link href={`/o/${org.id}`} className="hover:text-foreground">
              {org.name}
            </Link>
          ) : null}{' '}
          / project
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {project.data?.name ?? <Skeleton className="h-7 w-56" />}
          </h1>
          {role ? (
            <Badge tone="outline" className="capitalize">
              {role}
            </Badge>
          ) : null}
          {project.data?.archivedAt ? <Badge tone="warning">archived</Badge> : null}
        </div>
        <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map(({ href, label, icon: Icon }) => {
            const target = `${base}${href}`;
            const active = href === '' ? pathname === base : pathname.startsWith(target);
            return (
              <Link
                key={label}
                href={target}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className={cn(inChat && 'min-h-0 flex-1')}>{children}</div>
    </div>
  );
}
