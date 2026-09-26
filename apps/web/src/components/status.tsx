import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

const STATUS: Record<string, { tone: Tone; label?: string; icon?: typeof Clock; spin?: boolean }> =
  {
    // runs
    queued: { tone: 'neutral', icon: Clock },
    running: { tone: 'info', icon: LoaderCircle, spin: true },
    awaiting_approval: { tone: 'warning', label: 'awaiting approval', icon: Hourglass },
    completed: { tone: 'success', icon: CircleCheck },
    failed: { tone: 'danger', icon: CircleX },
    cancelled: { tone: 'neutral', icon: Ban },
    timed_out: { tone: 'danger', label: 'timed out', icon: Clock },
    // documents
    uploaded: { tone: 'neutral', icon: Clock },
    extracting: { tone: 'info', icon: LoaderCircle, spin: true },
    chunking: { tone: 'info', icon: LoaderCircle, spin: true },
    embedding: { tone: 'info', icon: LoaderCircle, spin: true },
    indexed: { tone: 'success', icon: CircleCheck },
    // approvals and tool calls
    pending: { tone: 'warning', icon: Hourglass },
    approved: { tone: 'success', icon: ShieldCheck },
    rejected: { tone: 'danger', icon: CircleX },
    expired: { tone: 'neutral', icon: Clock },
    proposed: { tone: 'neutral' },
    executing: { tone: 'info', icon: LoaderCircle, spin: true },
    succeeded: { tone: 'success', icon: CircleCheck },
    denied: { tone: 'danger', icon: Ban },
    skipped: { tone: 'neutral' },
    // evaluation verdicts
    passed: { tone: 'success', icon: CircleCheck },
    error: { tone: 'danger', icon: CircleAlert },
    // validation
    repaired: { tone: 'info' },
    flagged: { tone: 'warning', icon: CircleAlert },
  };

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = STATUS[status] ?? { tone: 'neutral' as Tone };
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} className={className}>
      {Icon ? <Icon className={meta.spin ? 'animate-spin' : undefined} /> : null}
      {meta.label ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: string }) {
  return (
    <Badge tone={risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'neutral'}>
      {risk} risk
    </Badge>
  );
}
