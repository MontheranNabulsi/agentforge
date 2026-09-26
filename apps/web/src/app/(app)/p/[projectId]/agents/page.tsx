'use client';

import type { AgentDto } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AgentForm, emptyAgent } from '@/components/agent-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState, ErrorBox, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canManage, useCurrentOrg } from '@/lib/hooks';

export default function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const [creating, setCreating] = useState(false);
  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<AgentDto[]>(`/projects/${projectId}/agents`),
  });
  const create = useMutation({
    mutationFn: (body: object) =>
      api<AgentDto>(`/projects/${projectId}/agents`, { body: body as Record<string, unknown> }),
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
      toast.success(`Created ${agent.name}`);
      setCreating(false);
      router.push(`/p/${projectId}/agents/${agent.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Agents are versioned: every configuration change creates a new immutable version, and each
          run records the version it used.
        </p>
        {canManage(role) ? (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New agent
          </Button>
        ) : null}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New agent" className="max-w-3xl">
          <AgentForm
            initial={emptyAgent}
            submitLabel="Create agent"
            pending={create.isPending}
            readOnly={false}
            onSubmit={(value) => create.mutate(value)}
          />
        </DialogContent>
      </Dialog>
      {agents.isError ? <ErrorBox error={agents.error} /> : null}
      {!agents.data ? (
        <Skeleton className="h-40" />
      ) : agents.data.length === 0 ? (
        <EmptyState icon={<Bot />} title="No agents" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.data.map((agent) => (
            <Link key={agent.id} href={`/p/${projectId}/agents/${agent.id}`} className="group">
              <Card className="h-full p-5 transition-shadow group-hover:shadow-md group-hover:ring-1 group-hover:ring-primary/30">
                <div className="flex items-start gap-3">
                  <span className="rounded-lg bg-primary-soft p-2 text-primary">
                    <Bot className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium group-hover:text-primary">{agent.name}</h3>
                      {agent.isDefault ? <Badge tone="primary">default</Badge> : null}
                      <Badge tone="outline">v{agent.currentVersion.version}</Badge>
                      {agent.currentVersion.outputSchema ? (
                        <Badge tone="info">JSON output</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {agent.description || agent.currentVersion.instructions}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {agent.currentVersion.tools.map((t) => (
                    <code
                      key={t.tool}
                      className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {t.tool}
                    </code>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {agent.currentVersion.modelProfile} model · updated {timeAgo(agent.updatedAt)}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
