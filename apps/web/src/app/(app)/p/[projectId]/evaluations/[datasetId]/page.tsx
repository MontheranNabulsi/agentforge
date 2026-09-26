'use client';

import {
  EVAL_CATEGORIES,
  type AgentDto,
  type EvalCategory,
  type EvaluationCaseDto,
  type EvaluationDatasetDetailDto,
  type EvaluationRunDto,
  type Page,
} from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PassRate } from '@/components/pass-rate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canManage, canWrite, useCurrentOrg } from '@/lib/hooks';

const EXAMPLE_EXPECTATIONS = `{
  "answerIncludes": ["30 days"],
  "citesDocuments": ["Refund Policy"],
  "mustNotCallTools": ["http_request"]
}`;

function Expectations({ c }: { c: EvaluationCaseDto }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(c.expectations).map(([key, value]) => (
        <code
          key={key}
          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
        </code>
      ))}
    </div>
  );
}

export default function DatasetPage() {
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    category: 'rag_qa' as EvalCategory,
    input: '',
    expectations: EXAMPLE_EXPECTATIONS,
  });
  const [agentId, setAgentId] = useState('');
  const dataset = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => api<EvaluationDatasetDetailDto>(`/evaluation-datasets/${datasetId}`),
  });
  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<AgentDto[]>(`/projects/${projectId}/agents`),
  });
  const runs = useQuery({
    queryKey: ['evaluation-runs', projectId, datasetId],
    queryFn: () =>
      api<Page<EvaluationRunDto>>(
        `/projects/${projectId}/evaluation-runs?datasetId=${datasetId}&limit=20`,
      ),
    refetchInterval: (q) =>
      q.state.data?.data.some((r) => r.status === 'queued' || r.status === 'running')
        ? 2_000
        : false,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] }),
    ]);

  const addCase = useMutation({
    mutationFn: () => {
      let expectations: unknown;
      try {
        expectations = JSON.parse(draft.expectations);
      } catch {
        throw new Error('Expectations must be valid JSON');
      }
      return api<EvaluationCaseDto>(`/evaluation-datasets/${datasetId}/cases`, {
        body: {
          name: draft.name,
          category: draft.category,
          input: draft.input,
          expectations: expectations as Record<string, unknown>,
          tags: [],
        },
      });
    },
    onSuccess: async () => {
      toast.success('Case added');
      setAdding(false);
      setDraft({ ...draft, name: '', input: '' });
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const deleteCase = useMutation({
    mutationFn: (caseId: string) => api(`/evaluation-cases/${caseId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (error) => toast.error(errorMessage(error)),
  });
  const start = useMutation({
    mutationFn: () => {
      const target =
        agentId || dataset.data?.lastRun?.agentId || agents.data?.find((a) => a.isDefault)?.id;
      if (!target) throw new Error('Choose an agent');
      return api<EvaluationRunDto>(`/evaluation-datasets/${datasetId}/runs`, {
        body: { agentId: target },
      });
    },
    onSuccess: (run) => {
      toast.success('Evaluation started');
      router.push(`/evaluation-runs/${run.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (dataset.isError) return <ErrorBox error={dataset.error} />;
  const d = dataset.data;

  return (
    <>
      <Link
        href={`/p/${projectId}/evaluations`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Evaluations
      </Link>
      <PageHeader
        title={d?.name ?? <Skeleton className="h-7 w-48" />}
        description={
          d ? `${d.description} · ${d.cases.length} cases · revision ${d.revision}` : undefined
        }
        actions={
          canWrite(role) ? (
            <>
              <Select
                className="h-9 w-48"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                aria-label="Agent to evaluate"
              >
                <option value="">
                  {agents.data?.find((a) => a.id === (d?.lastRun?.agentId ?? ''))?.name ??
                    agents.data?.find((a) => a.isDefault)?.name ??
                    'Agent'}
                </option>
                {(agents.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} (v{a.currentVersion.version})
                  </option>
                ))}
              </Select>
              <Button
                onClick={() => start.mutate()}
                loading={start.isPending}
                disabled={!d || d.cases.length === 0}
              >
                <Play /> Run evaluation
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Cases</CardTitle>
            {canManage(role) ? (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Plus /> Add case
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {(d?.cases ?? []).map((c) => (
              <div key={c.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  <Badge tone="outline">{c.category.replace('_', ' ')}</Badge>
                  {canManage(role) ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label="Delete case"
                      onClick={() => deleteCase.mutate(c.id)}
                    >
                      <Trash2 className="!size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <p className="my-1.5 text-sm text-muted-foreground">“{c.input}”</p>
                <Expectations c={c} />
              </div>
            ))}
            {d && d.cases.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cases yet.</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Runs of this dataset</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(runs.data?.data ?? []).map((r) => (
              <Link
                key={r.id}
                href={`/evaluation-runs/${r.id}`}
                className="block rounded-lg border border-border p-2.5 hover:border-primary/40"
              >
                <div className="flex items-center justify-between">
                  <PassRate run={r} />
                  <span className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.agentName} v{r.agentVersion} · {r.passed}/{r.totalCases} passed
                </p>
              </Link>
            ))}
            {runs.data && runs.data.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not run yet.</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title="Add a case" className="max-w-xl">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              addCase.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="case-name">
                <Input
                  id="case-name"
                  required
                  minLength={2}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="Category" htmlFor="case-category">
                <Select
                  id="case-category"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as EvalCategory })}
                >
                  {EVAL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c.replace('_', ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Input" htmlFor="case-input">
              <Textarea
                id="case-input"
                required
                value={draft.input}
                onChange={(e) => setDraft({ ...draft, input: e.target.value })}
                placeholder="What the user asks"
              />
            </Field>
            <Field
              label="Expectations (JSON)"
              htmlFor="case-expectations"
              hint="Keys: mustCallTools, mustNotCallTools, answerIncludes, answerExcludes, citesDocuments, mustRefuse, approvalRequested, outputMatchesSchema, maxDurationMs"
            >
              <Textarea
                id="case-expectations"
                rows={6}
                className="font-mono text-xs"
                value={draft.expectations}
                onChange={(e) => setDraft({ ...draft, expectations: e.target.value })}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={addCase.isPending}>
                Add case
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
