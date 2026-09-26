import type { Citation } from '@agentforge/contracts';
import { FileText } from 'lucide-react';
import Link from 'next/link';

export function Citations({
  citations,
  projectId,
  prefix,
}: {
  citations: Citation[];
  projectId: string;
  prefix: string;
}) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">Sources</p>
      {citations.map((c) => (
        <details
          key={c.index}
          id={`${prefix}-${c.index}`}
          className="group rounded-lg border border-border bg-subtle text-xs target:ring-2 target:ring-primary/40"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
            <span className="flex size-4 items-center justify-center rounded bg-primary-soft text-[10px] font-semibold text-primary">
              {c.index}
            </span>
            <FileText className="size-3.5 text-muted-foreground" />
            <span className="truncate font-medium">{c.documentTitle}</span>
            {c.headingPath ? (
              <span className="hidden truncate text-muted-foreground sm:inline">
                › {c.headingPath}
              </span>
            ) : null}
            {c.pageNumber ? <span className="text-muted-foreground">p. {c.pageNumber}</span> : null}
          </summary>
          <div className="border-t border-border px-2.5 py-2">
            <p className="leading-relaxed text-muted-foreground">{c.snippet}</p>
            <Link
              href={`/p/${projectId}/documents/${c.documentId}`}
              className="mt-1 inline-block text-primary"
            >
              Open document →
            </Link>
          </div>
        </details>
      ))}
    </div>
  );
}
