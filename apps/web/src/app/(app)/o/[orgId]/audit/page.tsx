'use client';

import type { AuditEventDto, Page } from '@agentforge/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { EmptyState, ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

const PREFIXES = [
  '',
  'approval.',
  'tool.',
  'run.',
  'document.',
  'agent.',
  'member.',
  'project.',
  'evaluation.',
];

export default function AuditPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [action, setAction] = useState('');
  const events = useInfiniteQuery({
    queryKey: ['audit', orgId, action],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Page<AuditEventDto>>(
        `/orgs/${orgId}/audit-events?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Audit log"
        description="Append-only record of who did what — people, agents (on whose behalf) and the system. The database rejects edits and deletes."
        actions={
          <Select
            className="w-44"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Filter by action"
          >
            {PREFIXES.map((p) => (
              <option key={p} value={p}>
                {p ? `${p.replace('.', '')} events` : 'All events'}
              </option>
            ))}
          </Select>
        }
      />
      {events.isError ? <ErrorBox error={events.error} /> : null}
      {!events.data ? (
        <Skeleton className="h-96" />
      ) : rows.length === 0 ? (
        <EmptyState title="No events" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-subtle text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((event) => (
                <tr key={event.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {dateTime(event.createdAt)}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium">{event.actorName ?? event.actorType}</span>{' '}
                    {event.actorType !== 'user' ? (
                      <Badge tone={event.actorType === 'agent' ? 'primary' : 'neutral'}>
                        {event.actorType}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{event.action}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {event.targetType}
                    {event.runId ? (
                      <>
                        {' · '}
                        <Link className="text-primary" href={`/runs/${event.runId}`}>
                          run
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td className="max-w-md px-4 py-2 font-mono text-[11px] text-muted-foreground">
                    <span className="line-clamp-3 break-all">
                      {Object.keys(event.metadata).length ? JSON.stringify(event.metadata) : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {events.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() => void events.fetchNextPage()}
            loading={events.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
