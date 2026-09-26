'use client';

import type { ProjectOverviewDto } from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { FileText, FlaskConical, Gauge, Inbox, MessageSquare, Timer, Zap } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ActivityList } from '@/components/activity';
import { RunsChart } from '@/components/runs-chart';
import { Stat } from '@/components/stat';
import { StatusBadge } from '@/components/status';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorBox, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { compact, duration, percent, timeAgo } from '@/lib/format';

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const overview = useQuery({
    queryKey: ['project-overview', projectId],
    queryFn: () => api<ProjectOverviewDto>(`/projects/${projectId}/overview`),
    refetchInterval: 30_000,
  });
  if (overview.isError) return <ErrorBox error={overview.error} />;
  const data = overview.data;
  const stats = data?.stats;
  const evaluation = stats?.latestEvaluation;

  return (
    <div className="space-y-6">
      {data?.project.description ? (
        <p className="-mt-2 text-sm text-muted-foreground">{data.project.description}</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Knowledge"
          icon={<FileText />}
          value={stats ? stats.documents.indexed : '—'}
          hint={
            stats
              ? `${stats.documents.total} documents · ${stats.documents.processing} processing · ${stats.documents.failed} failed`
              : ' '
          }
        />
        <Stat
          label="Runs (7 days)"
          icon={<Zap />}
          value={stats ? stats.runs7d : '—'}
          hint={
            stats
              ? `${percent(stats.successRate7d)} success · ${compact(stats.tokens7d)} tokens`
              : ' '
          }
        />
        <Stat
          label="Latency (7 days)"
          icon={<Timer />}
          value={stats ? duration(stats.p50DurationMs7d) : '—'}
          hint={stats ? `p50 · p95 ${duration(stats.p95DurationMs7d)}` : ' '}
        />
        <Stat
          label="Latest evaluation"
          icon={<FlaskConical />}
          value={evaluation ? percent(evaluation.passRate) : '—'}
          hint={
            evaluation
              ? `${evaluation.datasetName}${evaluation.previousPassRate !== null ? ` · was ${percent(evaluation.previousPassRate)}` : ''}`
              : 'No evaluation yet'
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Runs per day</CardTitle>
            <span className="text-xs text-muted-foreground">last 14 days</span>
          </CardHeader>
          <CardContent>
            {data ? <RunsChart data={data.runsPerDay} /> : <Skeleton className="h-40" />}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Inbox className="size-4 text-warning" /> Pending approvals
              </div>
              <span className="text-lg font-semibold tabular-nums">
                {stats?.pendingApprovals ?? '—'}
              </span>
            </div>
            {stats?.pendingApprovals && data ? (
              <Link
                href={`/o/${data.project.organizationId}/approvals`}
                className={buttonVariants({
                  variant: 'outline',
                  size: 'sm',
                  className: 'mt-3 w-full',
                })}
              >
                Review
              </Link>
            ) : null}
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <MessageSquare className="size-4 text-primary" /> Recent conversations
            </div>
            <ul className="space-y-1.5 text-sm">
              {(data?.recentConversations ?? []).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <Link
                    href={`/p/${projectId}/chat/${c.id}`}
                    className="truncate hover:text-primary"
                  >
                    {c.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(c.lastMessageAt)}
                  </span>
                </li>
              ))}
              {data && data.recentConversations.length === 0 ? (
                <li className="text-muted-foreground">None yet</li>
              ) : null}
            </ul>
            <Link
              href={`/p/${projectId}/chat`}
              className={buttonVariants({ size: 'sm', className: 'mt-3 w-full' })}
            >
              Start a chat
            </Link>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent runs</CardTitle>
            <Link href={`/p/${projectId}/runs`} className="text-xs text-primary">
              All runs →
            </Link>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {(data?.recentRuns ?? []).map((run) => (
                  <tr key={run.id} className="hover:bg-subtle">
                    <td className="px-5 py-2">
                      <Link href={`/runs/${run.id}`} className="line-clamp-1 hover:text-primary">
                        {run.inputPreview}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {run.agentName} · {run.intent ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="hidden px-2 py-2 text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
                      {duration(run.durationMs)}
                    </td>
                    <td className="hidden px-5 py-2 text-right text-xs text-muted-foreground sm:table-cell">
                      {timeAgo(run.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.recentRuns.length === 0 ? (
              <p className="px-5 text-sm text-muted-foreground">No runs yet — start a chat.</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4" /> Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data ? <ActivityList events={data.recentActivity} /> : <Skeleton className="h-40" />}
          </CardContent>
        </Card>
      </div>
      {data ? (
        <p className="text-right text-[11px] text-muted-foreground">
          Figures cached for up to 30 s · updated {timeAgo(data.cachedAt)}
        </p>
      ) : null}
    </div>
  );
}
