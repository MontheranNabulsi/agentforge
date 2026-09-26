'use client';

import type { EvaluationRunDetailDto } from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, CircleX } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Stat } from '@/components/stat';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ErrorBox, PageHeader, Skeleton, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { dateTime, duration, percent } from '@/lib/format';

export default function EvaluationRunPage() {
  const { evaluationRunId } = useParams<{ evaluationRunId: string }>();
  const run = useQuery({
    queryKey: ['evaluation-run', evaluationRunId],
    queryFn: () => api<EvaluationRunDetailDto>(`/evaluation-runs/${evaluationRunId}`),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running')
        ? 1_500
        : false,
  });
  if (run.isError) return <ErrorBox error={run.error} />;
  const r = run.data;
  if (!r) return <Skeleton className="h-96" />;
  const done = r.results.length;

  return (
    <>
      <button
        onClick={() => history.back()}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back
      </button>
      <PageHeader
        eyebrow="Evaluation run"
        title={r.datasetName}
        description={`${r.agentName} v${r.agentVersion} · ${r.provider === 'fake' ? 'deterministic demo model' : `${r.provider}:${r.model}`} · prompt ${r.promptVersion}${r.gitSha ? ` · ${r.gitSha.slice(0, 7)}` : ''} · dataset revision ${r.datasetRevision}`}
        actions={<StatusBadge status={r.status} />}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Pass rate"
          value={r.status === 'completed' ? percent(r.passRate) : `${done}/${r.totalCases}`}
          hint={
            r.status === 'running' ? (
              <Spinner label="running cases…" />
            ) : (
              `${r.passed} passed · ${r.failed} failed · ${r.errored} errors`
            )
          }
        />
        <Stat
          label="Regressions"
          value={r.regressions}
          hint={
            r.baselineRunId ? (
              <Link className="text-primary" href={`/evaluation-runs/${r.baselineRunId}`}>
                vs baseline run →
              </Link>
            ) : (
              'No baseline yet'
            )
          }
        />
        <Stat
          label="Started"
          value={<span className="text-base">{dateTime(r.startedAt ?? r.createdAt)}</span>}
        />
        <Stat
          label="Finished"
          value={<span className="text-base">{dateTime(r.completedAt)}</span>}
        />
      </div>
      <Card className="divide-y divide-border">
        {r.results.map((result) => (
          <details key={result.id} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
              {result.verdict === 'passed' ? (
                <CircleCheck className="size-4 text-success" />
              ) : (
                <CircleX className="size-4 text-danger" />
              )}
              <span className="font-medium">{result.caseName}</span>
              <Badge tone="outline">{result.category.replace('_', ' ')}</Badge>
              {result.regression ? <Badge tone="danger">regression</Badge> : null}
              {result.baselineVerdict &&
              !result.regression &&
              result.baselineVerdict !== result.verdict ? (
                <Badge tone="success">fixed</Badge>
              ) : null}
              <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">score {result.score.toFixed(2)}</span>
                <span className="tabular-nums">{duration(result.durationMs)}</span>
                <StatusBadge status={result.verdict} />
              </span>
            </summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="space-y-2 text-sm">
                <p className="text-xs font-medium text-muted-foreground">Input</p>
                <p>“{result.input}”</p>
                <p className="text-xs font-medium text-muted-foreground">Output</p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">
                  {result.output || '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Tools: {result.toolsCalled.join(', ') || 'none'}
                  {result.agentRunId ? (
                    <>
                      {' · '}
                      <Link className="text-primary" href={`/runs/${result.agentRunId}`}>
                        inspect run →
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              <ul className="space-y-1.5 text-sm">
                {result.evaluatorResults.map((e) => (
                  <li key={e.evaluator} className="flex gap-2">
                    {e.passed ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
                    )}
                    <span>
                      <code className="text-xs">{e.evaluator}</code>{' '}
                      <span className="text-muted-foreground">— {e.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
        {r.results.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {r.status === 'failed'
              ? 'The evaluation failed to run.'
              : 'Waiting for the first case…'}
          </p>
        ) : null}
      </Card>
    </>
  );
}
