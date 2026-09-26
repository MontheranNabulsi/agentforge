'use client';

import type { EvaluationDatasetDto, EvaluationRunDto, Page } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PassRate } from '@/components/pass-rate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState, ErrorBox, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canManage, useCurrentOrg } from '@/lib/hooks';

export default function EvaluationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const datasets = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api<EvaluationDatasetDto[]>(`/projects/${projectId}/evaluation-datasets`),
  });
  const runs = useQuery({
    queryKey: ['evaluation-runs', projectId],
    queryFn: () => api<Page<EvaluationRunDto>>(`/projects/${projectId}/evaluation-runs?limit=20`),
    refetchInterval: (q) =>
      q.state.data?.data.some((r) => r.status === 'queued' || r.status === 'running')
        ? 2_000
        : 30_000,
  });
  const create = useMutation({
    mutationFn: () =>
      api<EvaluationDatasetDto>(`/projects/${projectId}/evaluation-datasets`, { body: form }),
    onSuccess: async (dataset) => {
      await queryClient.invalidateQueries({ queryKey: ['datasets', projectId] });
      setCreating(false);
      router.push(`/p/${projectId}/evaluations/${dataset.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          A dataset is a list of inputs with expectations. Running it scores the agent's pinned
          version and flags cases that passed before but fail now.
        </p>
        {canManage(role) ? (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New dataset
          </Button>
        ) : null}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New evaluation dataset">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" htmlFor="ds-name">
              <Input
                id="ds-name"
                required
                minLength={2}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Description" htmlFor="ds-description">
              <Textarea
                id="ds-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={create.isPending}>
                Create dataset
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {datasets.isError ? <ErrorBox error={datasets.error} /> : null}
      {!datasets.data ? (
        <Skeleton className="h-32" />
      ) : datasets.data.length === 0 ? (
        <EmptyState
          icon={<FlaskConical />}
          title="No datasets yet"
          description="Create one and add cases such as “answers the refund question and cites the policy”."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {datasets.data.map((d) => (
            <Link key={d.id} href={`/p/${projectId}/evaluations/${d.id}`} className="group">
              <Card className="h-full p-5 group-hover:shadow-md group-hover:ring-1 group-hover:ring-primary/30">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium group-hover:text-primary">{d.name}</h3>
                  <PassRate run={d.lastRun} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {d.description || 'No description'}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {d.caseCount} cases · revision {d.revision}
                  {d.lastRun
                    ? ` · last run ${timeAgo(d.lastRun.createdAt)} on ${d.lastRun.agentName} v${d.lastRun.agentVersion}`
                    : ''}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent evaluation runs</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {(runs.data?.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-subtle">
                  <td className="px-5 py-2">
                    <Link
                      className="font-medium hover:text-primary"
                      href={`/evaluation-runs/${r.id}`}
                    >
                      {r.datasetName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.agentName} v{r.agentVersion} · {r.provider}:{r.model} · prompt{' '}
                      {r.promptVersion}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <PassRate run={r} />
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {r.passed}/{r.totalCases}
                  </td>
                  <td className="px-5 py-2 text-right text-xs text-muted-foreground">
                    {timeAgo(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.data && runs.data.data.length === 0 ? (
            <p className="px-5 text-sm text-muted-foreground">No evaluation runs yet.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
