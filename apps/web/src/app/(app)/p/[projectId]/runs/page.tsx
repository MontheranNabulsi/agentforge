'use client';

import type { Page, RunStatus, RunSummaryDto } from '@agentforge/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { EmptyState, ErrorBox, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { compact, duration, timeAgo } from '@/lib/format';

const STATUSES: RunStatus[] = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const runs = useInfiniteQuery({
    queryKey: ['runs', projectId, status, trigger],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Page<RunSummaryDto>>(
        `/projects/${projectId}/runs?limit=30${status ? `&status=${status}` : ''}${trigger ? `&trigger=${trigger}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = runs.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          className="w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
        <Select
          className="w-40"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          aria-label="Trigger"
        >
          <option value="">Chat and evals</option>
          <option value="chat">Chat</option>
          <option value="evaluation">Evaluation</option>
        </Select>
      </div>
      {runs.isError ? <ErrorBox error={runs.error} /> : null}
      {!runs.data ? (
        <Skeleton className="h-96" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="No runs match" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-subtle text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Input</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Agent</th>
                <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Steps</th>
                <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((run) => (
                <tr key={run.id} className="hover:bg-subtle">
                  <td className="max-w-md px-4 py-2">
                    <Link
                      href={`/runs/${run.id}`}
                      className="line-clamp-1 font-medium hover:text-primary"
                    >
                      {run.inputPreview}
                    </Link>
                    <span className="flex gap-1.5 text-xs text-muted-foreground">
                      {run.intent ?? '—'}
                      {run.trigger === 'evaluation' ? <Badge tone="outline">eval</Badge> : null}
                      {run.errorCode ? <span className="text-danger">{run.errorCode}</span> : null}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                    {run.agentName} <span className="text-xs">v{run.agentVersion}</span>
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
                    {run.stepCount}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
                    {compact(run.totalTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{duration(run.durationMs)}</td>
                  <td className="hidden whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground sm:table-cell">
                    {timeAgo(run.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {runs.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() => void runs.fetchNextPage()}
            loading={runs.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
