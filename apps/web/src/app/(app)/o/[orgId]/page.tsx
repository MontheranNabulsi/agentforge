'use client';

import type { ProjectDto } from '@agentforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, FolderKanban, Inbox, MessageSquare, Plus, Users, Zap } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ActivityList } from '@/components/activity';
import { Stat } from '@/components/stat';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState, ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canManage, useOrgOverview } from '@/lib/hooks';

function NewProjectDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', description: '' });
  const create = useMutation({
    mutationFn: () => api<ProjectDto>(`/orgs/${orgId}/projects`, { body: form }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['org-overview', orgId] });
      toast.success(`Created ${project.name} with a default assistant agent`);
      onOpenChange(false);
      router.push(`/p/${project.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New project"
        description="A project holds documents, agents, conversations and evaluations. It starts with a default assistant."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name" htmlFor="project-name">
            <Input
              id="project-name"
              required
              minLength={2}
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Customer Support"
            />
          </Field>
          <Field label="Description" htmlFor="project-description">
            <Textarea
              id="project-description"
              maxLength={500}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What the agents in this project help with"
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={create.isPending}>
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrgDashboard() {
  const { orgId } = useParams<{ orgId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const overview = useOrgOverview(orgId);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (search.get('new') === 'project') {
      setCreating(true);
      router.replace(`/o/${orgId}`);
    }
  }, [search, orgId, router]);

  if (overview.isError) return <ErrorBox error={overview.error} />;
  const data = overview.data;
  const manage = canManage(data?.organization.role);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title={data?.organization.name ?? <Skeleton className="h-7 w-48" />}
        description="Projects, pending approvals and what happened recently."
        actions={
          manage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </Button>
          ) : null
        }
      />
      <NewProjectDialog orgId={orgId} open={creating} onOpenChange={setCreating} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Projects" value={data?.projects.length ?? '—'} icon={<FolderKanban />} />
        <Stat label="Members" value={data?.memberCount ?? '—'} icon={<Users />} />
        <Stat
          label="Pending approvals"
          value={data?.pendingApprovals ?? '—'}
          icon={<Inbox />}
          hint={
            data?.pendingApprovals ? (
              <Link className="text-primary" href={`/o/${orgId}/approvals`}>
                Review now →
              </Link>
            ) : (
              'Nothing waiting'
            )
          }
        />
        <Stat
          label="Runs (7 days)"
          value={data ? data.projects.reduce((sum, p) => sum + p.runCount7d, 0) : '—'}
          icon={<Zap />}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">Projects</h2>
          {!data ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
            </div>
          ) : data.projects.length === 0 ? (
            <EmptyState
              icon={<FolderKanban />}
              title="No projects yet"
              description={
                manage
                  ? 'Create a project to upload documents and chat with its agent.'
                  : 'Ask an admin to create a project.'
              }
              action={
                manage ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus /> New project
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.projects.map((project) => (
                <Link key={project.id} href={`/p/${project.id}`} className="group">
                  <Card className="h-full p-4 transition-shadow group-hover:shadow-md group-hover:ring-1 group-hover:ring-primary/30">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-medium group-hover:text-primary">{project.name}</h3>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(project.lastActivityAt)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">
                      {project.description || 'No description'}
                    </p>
                    <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="size-3.5" /> {project.documentCount} docs
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageSquare className="size-3.5" /> {project.conversationCount} chats
                      </span>
                      <span className="flex items-center gap-1">
                        <Zap className="size-3.5" /> {project.runCount7d} runs / 7d
                      </span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data ? <ActivityList events={data.recentActivity} /> : <Skeleton className="h-40" />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default function OrgDashboardPage() {
  return (
    <Suspense>
      <OrgDashboard />
    </Suspense>
  );
}
