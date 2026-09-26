'use client';

import type { AgentDto, AgentVersionDto } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { AgentForm, fromAgent, type AgentFormValue } from '@/components/agent-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { ApiError, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canManage, useCurrentOrg } from '@/lib/hooks';

async function fetchAgent(agentId: string): Promise<{ agent: AgentDto; etag: string | null }> {
  const response = await fetch(`/api/v1/agents/${agentId}`, { credentials: 'same-origin' });
  const body = (await response.json()) as AgentDto & { detail?: string };
  if (!response.ok) throw new ApiError(response.status, body as never);
  return { agent: body, etag: response.headers.get('etag') };
}

export default function AgentPage() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const agent = useQuery({ queryKey: ['agent', agentId], queryFn: () => fetchAgent(agentId) });
  const versions = useQuery({
    queryKey: ['agent-versions', agentId],
    queryFn: async () =>
      (await (
        await fetch(`/api/v1/agents/${agentId}/versions`, { credentials: 'same-origin' })
      ).json()) as AgentVersionDto[],
  });

  const save = useMutation({
    mutationFn: async (value: AgentFormValue) => {
      const response = await fetch(`/api/v1/agents/${agentId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(agent.data?.etag ? { 'if-match': agent.data.etag } : {}),
        },
        body: JSON.stringify(value),
      });
      const body = (await response.json()) as AgentDto;
      if (!response.ok) throw new ApiError(response.status, body as never);
      return body;
    },
    onSuccess: async (updated) => {
      toast.success(`Saved · now version ${updated.currentVersion.version}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] }),
        queryClient.invalidateQueries({ queryKey: ['agent-versions', agentId] }),
        queryClient.invalidateQueries({ queryKey: ['agents', projectId] }),
      ]);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const makeDefault = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/v1/agents/${agentId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!response.ok) throw new ApiError(response.status, (await response.json()) as never);
    },
    onSuccess: async () => {
      toast.success('Now the default agent for new conversations');
      await queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      await queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (agent.isError) return <ErrorBox error={agent.error} />;
  const data = agent.data?.agent;
  const manage = canManage(role);

  return (
    <>
      <Link
        href={`/p/${projectId}/agents`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Agents
      </Link>
      <PageHeader
        title={
          data ? (
            <span className="flex items-center gap-2">
              {data.name} <Badge tone="outline">v{data.currentVersion.version}</Badge>{' '}
              {data.isDefault ? <Badge tone="primary">default</Badge> : null}
            </span>
          ) : (
            <Skeleton className="h-7 w-48" />
          )
        }
        description={
          data
            ? `Prompt template ${data.currentVersion.promptVersion} · ${manage ? 'Saving a configuration change creates a new version.' : 'Read-only: admins can edit agents.'}`
            : undefined
        }
        actions={
          data && manage && !data.isDefault ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => makeDefault.mutate()}
              loading={makeDefault.isPending}
            >
              Make default
            </Button>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="p-5">
          {data ? (
            <AgentForm
              key={data.currentVersion.id}
              initial={fromAgent(data)}
              submitLabel="Save as new version"
              pending={save.isPending}
              readOnly={!manage}
              onSubmit={(value) => save.mutate(value)}
            />
          ) : (
            <Skeleton className="h-96" />
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" /> Versions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {(versions.data ?? []).map((v) => (
                <li key={v.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={v.version === data?.currentVersion.version ? 'primary' : 'outline'}
                    >
                      v{v.version}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {v.createdBy?.name ?? 'system'} · {v.modelProfile} · {v.tools.length} tools
                    {v.outputSchema ? ' · JSON output' : ''}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
