'use client';

import type { ChunkDto, DocumentDto } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { bytes, dateTime } from '@/lib/format';
import { canWrite, useCurrentOrg } from '@/lib/hooks';

export default function DocumentPage() {
  const { projectId, documentId } = useParams<{ projectId: string; documentId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const document = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api<DocumentDto>(`/documents/${documentId}`),
    refetchInterval: (q) =>
      q.state.data && !['indexed', 'failed'].includes(q.state.data.status) ? 2_000 : false,
  });
  const chunks = useQuery({
    queryKey: ['chunks', documentId, document.data?.indexedAt],
    queryFn: () => api<ChunkDto[]>(`/documents/${documentId}/chunks?limit=200`),
    enabled: document.data?.status === 'indexed',
  });
  const reindex = useMutation({
    mutationFn: () => api<DocumentDto>(`/documents/${documentId}/reindex`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Re-indexing started');
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/documents/${documentId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Document deleted');
      await queryClient.invalidateQueries({ queryKey: ['documents', projectId] });
      router.push(`/p/${projectId}/documents`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (document.isError) return <ErrorBox error={document.error} />;
  const doc = document.data;

  return (
    <>
      <Link
        href={`/p/${projectId}/documents`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Knowledge
      </Link>
      <PageHeader
        title={doc?.title ?? <Skeleton className="h-7 w-64" />}
        description={
          doc
            ? `${doc.sourceFilename ?? 'agent note'} · ${bytes(doc.sizeBytes)} · ${doc.chunkCount} chunks · ~${doc.tokenCount} tokens${doc.pageCount ? ` · ${doc.pageCount} pages` : ''} · indexed ${dateTime(doc.indexedAt)}`
            : undefined
        }
        actions={
          doc && canWrite(role) ? (
            <>
              <StatusBadge status={doc.status} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => reindex.mutate()}
                loading={reindex.isPending}
              >
                <RefreshCw /> Re-index
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete “${doc.title}”? Agents will no longer find it.`))
                    remove.mutate();
                }}
                loading={remove.isPending}
              >
                <Trash2 /> Delete
              </Button>
            </>
          ) : null
        }
      />
      {doc?.injectionFlags.length ? (
        <div className="mb-4 flex gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div>
            <p className="font-medium">
              This document contains text that looks like instructions to an AI (
              {doc.injectionFlags.join(', ')}).
            </p>
            <p className="mt-0.5 text-muted-foreground">
              It stays searchable, but agents treat retrieved passages as untrusted data and are
              told never to follow instructions inside them. Detection is pattern-based and can miss
              rephrased attacks.
            </p>
          </div>
        </div>
      ) : null}
      {doc?.errorMessage ? (
        <ErrorBox error={new Error(`${doc.errorCode}: ${doc.errorMessage}`)} className="mb-4" />
      ) : null}
      <h2 className="mb-2 text-sm font-semibold">Chunks</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        What retrieval actually searches: heading-aware passages with a small overlap, each embedded
        and full-text indexed.
      </p>
      {doc?.status !== 'indexed' ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-3">
          {(chunks.data ?? []).map((chunk) => (
            <Card key={chunk.id} className="p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">#{chunk.index}</span>
                {chunk.headingPath ? <span>{chunk.headingPath}</span> : null}
                {chunk.pageNumber ? <span>page {chunk.pageNumber}</span> : null}
                <span className="ml-auto">~{chunk.tokenCount} tokens</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{chunk.content}</p>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
