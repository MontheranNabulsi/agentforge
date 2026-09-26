'use client';

import type { ApprovalDto, Page } from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApprovalCard } from '@/components/approval-card';
import { EmptyState, ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { canWrite, useCurrentOrg } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
] as const;

export default function ApprovalsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { role } = useCurrentOrg();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('pending');
  const approvals = useQuery({
    queryKey: ['approvals', orgId, filter],
    queryFn: () =>
      api<Page<ApprovalDto>>(
        `/orgs/${orgId}/approvals?limit=50${filter === 'all' ? '' : `&status=${filter}`}`,
      ),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader
        eyebrow="Human in the loop"
        title="Approvals"
        description="Agents pause here before any action that changes data. Approving resumes the run; rejecting tells the agent not to do it."
      />
      <div className="mb-4 inline-flex rounded-lg border border-border bg-card p-0.5 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-md px-3 py-1',
              filter === f.key
                ? 'bg-muted font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {approvals.isError ? <ErrorBox error={approvals.error} /> : null}
      {!approvals.data ? (
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : approvals.data.data.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={filter === 'pending' ? 'Nothing waiting for a decision' : 'No approvals here'}
          description="Ask an agent to save a note or send a POST request and its request will appear here."
        />
      ) : (
        <div className="space-y-4">
          {approvals.data.data.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} canDecide={canWrite(role)} />
          ))}
        </div>
      )}
    </>
  );
}
