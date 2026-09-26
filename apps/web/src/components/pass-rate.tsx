import type { EvaluationRunDto } from '@agentforge/contracts';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { percent } from '@/lib/format';

export function PassRate({ run }: { run: EvaluationRunDto | null }) {
  if (!run) return <span className="text-muted-foreground">never run</span>;
  if (run.status !== 'completed') return <StatusBadge status={run.status} />;
  const tone =
    (run.passRate ?? 0) === 1
      ? 'text-success'
      : (run.passRate ?? 0) >= 0.8
        ? 'text-warning'
        : 'text-danger';
  return (
    <span className="flex items-center gap-2">
      <span className={`font-semibold tabular-nums ${tone}`}>{percent(run.passRate)}</span>
      {run.regressions ? (
        <Badge tone="danger">
          {run.regressions} regression{run.regressions === 1 ? '' : 's'}
        </Badge>
      ) : null}
    </span>
  );
}
