import type { RunsPerDayDto } from '@agentforge/contracts';

/** Stacked daily bars: completed / failed / other. Plain SVG; no chart library needed. */
export function RunsChart({ data }: { data: RunsPerDayDto[] }) {
  const max = Math.max(1, ...data.map((d) => d.completed + d.failed + d.other));
  const width = 100 / Math.max(data.length, 1);
  return (
    <div>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-36 w-full"
        role="img"
        aria-label="Runs per day"
      >
        {data.map((d, i) => {
          const total = d.completed + d.failed + d.other;
          const x = i * width + width * 0.18;
          const w = width * 0.64;
          const scale = (v: number) => (v / max) * 38;
          const hc = scale(d.completed);
          const hf = scale(d.failed);
          const ho = scale(d.other);
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${d.completed} completed, ${d.failed} failed, ${d.other} other`}</title>
              <rect x={x} y={40 - hc} width={w} height={hc} rx={0.6} className="fill-success/80" />
              <rect
                x={x}
                y={40 - hc - hf}
                width={w}
                height={hf}
                rx={0.6}
                className="fill-danger/80"
              />
              <rect
                x={x}
                y={40 - hc - hf - ho}
                width={w}
                height={ho}
                rx={0.6}
                className="fill-muted-foreground/40"
              />
              {total === 0 ? (
                <rect x={x} y={39.4} width={w} height={0.6} className="fill-border" />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{data[0]?.date.slice(5)}</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-success/80" /> completed
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-danger/80" /> failed
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-muted-foreground/40" /> other
          </span>
        </span>
        <span>{data.at(-1)?.date.slice(5)}</span>
      </div>
    </div>
  );
}
