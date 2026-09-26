'use client';

import type { ApprovalDto } from '@agentforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, ShieldAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { RiskBadge, StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export function ApprovalCard({
  approval,
  canDecide,
  compact = false,
  onDecided,
}: {
  approval: ApprovalDto;
  canDecide: boolean;
  compact?: boolean;
  onDecided?: (a: ApprovalDto) => void;
}) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<ApprovalDto>(`/approvals/${approval.id}/decision`, {
        body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      }),
    onSuccess: async (updated) => {
      toast.success(
        updated.status === 'approved'
          ? 'Approved; the agent continues'
          : 'Rejected; the agent will be told',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approvals'] }),
        queryClient.invalidateQueries({ queryKey: ['org-overview'] }),
      ]);
      onDecided?.(updated);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pending = approval.status === 'pending';

  return (
    <Card className={cn('overflow-hidden', pending && 'ring-1 ring-warning/40')}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span
          className={cn(
            'rounded-lg p-2',
            pending ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground',
          )}
        >
          <ShieldAlert className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{approval.title}</p>
            <StatusBadge status={approval.status} />
            <RiskBadge risk={approval.riskLevel} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{approval.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">{approval.toolName}</span> · {approval.projectName} ·
            requested by {approval.requestedBy?.name ?? 'unknown'} {timeAgo(approval.requestedAt)}
            {pending ? ` · expires ${timeAgo(approval.expiresAt)}` : ''}
          </p>
        </div>
        {!compact ? (
          <Link
            href={`/runs/${approval.runId}`}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Run <ExternalLink className="size-3" />
          </Link>
        ) : null}
      </div>

      <div className="border-t border-border bg-subtle px-4 py-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          What will happen if approved
        </div>
        <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">Policy: {approval.policyReason}</p>
      </div>

      {pending ? (
        canDecide ? (
          <div className="flex flex-col gap-2 border-t border-border p-4 sm:flex-row sm:items-end">
            <Textarea
              className="min-h-9 flex-1"
              rows={1}
              placeholder="Optional comment for the audit log"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={1000}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => decide.mutate('reject')}
                loading={decide.isPending && decide.variables === 'reject'}
                disabled={decide.isPending}
              >
                <X /> Reject
              </Button>
              <Button
                variant="success"
                onClick={() => decide.mutate('approve')}
                loading={decide.isPending && decide.variables === 'approve'}
                disabled={decide.isPending}
              >
                <Check /> Approve
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Waiting for someone with the{' '}
            {approval.riskLevel === 'high' ? 'admin or owner' : 'member, admin or owner'} role.
          </p>
        )
      ) : approval.decidedAt ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {approval.status} {approval.decidedBy ? `by ${approval.decidedBy.name}` : 'automatically'}{' '}
          {timeAgo(approval.decidedAt)}
          {approval.decisionComment ? ` — “${approval.decisionComment}”` : ''}
        </p>
      ) : null}
    </Card>
  );
}
