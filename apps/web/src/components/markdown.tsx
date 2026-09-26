'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Renders model output as Markdown. Raw HTML is not rendered (react-markdown escapes it by
 * default), so an answer or a document cannot inject markup or scripts into the page.
 * Citation markers like [2] become small chips that jump to the source list.
 */
export function Markdown({
  text,
  className,
  citationPrefix,
}: {
  text: string;
  className?: string;
  citationPrefix?: string;
}) {
  const withCitations = citationPrefix
    ? text.replace(/\[(\d{1,3})\](?!\()/g, (_m, n: string) => `[${n}](#${citationPrefix}-${n})`)
    : text;
  return (
    <div className={cn('prose-chat text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (citationPrefix && href?.startsWith(`#${citationPrefix}-`)) {
              return (
                <a
                  href={href}
                  className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary-soft px-1 align-text-top text-[10px] font-semibold !text-primary !no-underline"
                >
                  {children}
                </a>
              );
            }
            const safe = href && /^(https?:|mailto:|\/|#)/i.test(href) ? href : undefined;
            return (
              <a
                href={safe}
                target={safe?.startsWith('http') ? '_blank' : undefined}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {withCitations}
      </ReactMarkdown>
    </div>
  );
}
