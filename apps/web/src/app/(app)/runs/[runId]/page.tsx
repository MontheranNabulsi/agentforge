'use client';

import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, CircleStop } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Citations } from '@/components/citations';
import { Markdown } from '@/components/markdown';
import { RunTimeline, TERMINAL, useLiveRun } from '@/components/run-timeline';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { compact, dateTime, duration } from '@/lib/format';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export default function RunInspectorPage() {
  const { runId } = useParams<{ runId: string }>();
  const { detail, streamText, live } = useLiveRun(runId);
  const cancel = useMutation({
    mutationFn: () => api(`/runs/${runId}/cancel`, { method: 'POST' }),
    onSuccess: () => toast.success('Cancellation requested'),
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (detail.isError) return <ErrorBox error={detail.error} />;
  const run = detail.data;
  if (!run) return <Skeleton className="h-96" />;

  return (
    <>
      <Link
        href={`/p/${run.projectId}/runs`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Runs
      </Link>
      <PageHeader
        eyebrow="Run inspector"
        title={<span className="line-clamp-2 whitespace-normal">{run.input}</span>}
        actions={
          <>
            <StatusBadge status={run.status} />
            {!TERMINAL.includes(run.status) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancel.mutate()}
                loading={cancel.isPending}
              >
                <CircleStop /> Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Steps</CardTitle>
              {live ? <Badge tone="info">live</Badge> : null}
            </CardHeader>
            <CardContent>
              <RunTimeline run={run} />
            </CardContent>
          </Card>
          {run.plan ? (
            <Card>
              <CardHeader>
                <CardTitle>Plan</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-sm text-muted-foreground">{run.plan.goal}</p>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {run.plan.steps.map((s) => (
                    <li key={s.id}>
                      {s.description}{' '}
                      {s.tool ? (
                        <code className="rounded bg-muted px-1 text-xs">{s.tool}</code>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Output</CardTitle>
            </CardHeader>
            <CardContent>
              {run.output ? (
                <>
                  {run.output.structured ? (
                    <pre className="overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                      {JSON.stringify(run.output.structured, null, 2)}
                    </pre>
                  ) : (
                    <Markdown text={run.output.text} citationPrefix="run-cite" />
                  )}
                  <Citations
                    citations={run.output.citations}
                    projectId={run.projectId}
                    prefix="run-cite"
                  />
                </>
              ) : streamText ? (
                <Markdown text={streamText} className="streaming-caret" />
              ) : run.error ? (
                <ErrorBox error={new Error(`${run.error.code}: ${run.error.message}`)} />
              ) : (
                <p className="text-sm text-muted-foreground">No output yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <Row label="Agent">
                {run.agentName} v{run.agentVersion}
              </Row>
              <Row label="Trigger">{run.trigger}</Row>
              <Row label="Intent">{run.intent ?? '—'}</Row>
              <Row label="Provider">
                {run.provider === 'fake' ? 'demo model (deterministic)' : run.provider}
              </Row>
              <Row label="Model">{run.model}</Row>
              <Row label="Prompt template">{run.agentConfig.promptVersion}</Row>
              <Row label="Tokens">
                {compact(run.promptTokens)} in · {compact(run.completionTokens)} out
              </Row>
              <Row label="Steps / tool calls">
                {run.steps.length} / {run.toolCalls.length}
              </Row>
              <Row label="Duration">{duration(run.durationMs)}</Row>
              <Row label="Created">{dateTime(run.createdAt)}</Row>
              <Row label="Deadline">{dateTime(run.deadlineAt)}</Row>
              <Row label="Request id">
                <code className="text-xs">{run.requestId ?? '—'}</code>
              </Row>
              <Row label="Run id">
                <code className="text-xs">{run.id}</code>
              </Row>
            </CardContent>
          </Card>
          {run.output?.validation ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Validation</CardTitle>
                <StatusBadge status={run.output.validation.status} />
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-xs">
                  {run.output.validation.checks.map((c) => (
                    <li key={c.name}>
                      <span className={c.passed ? 'text-success' : 'text-warning'}>
                        {c.passed ? '✓' : '!'}
                      </span>{' '}
                      <code>{c.name}</code>
                      <p className="text-muted-foreground">{c.detail}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {run.error ? (
            <Card className="border-danger/30">
              <CardHeader>
                <CardTitle className="text-danger">Error</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <code>{run.error.code}</code>
                <p className="mt-1 text-muted-foreground">{run.error.message}</p>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Tools available</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {run.agentConfig.tools.map((t) => (
                <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                  {t}
                </code>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
