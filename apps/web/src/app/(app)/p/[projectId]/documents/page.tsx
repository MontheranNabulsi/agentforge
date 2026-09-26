'use client';

import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_EXTENSIONS,
  type DocumentDto,
  type KnowledgeSearchResponse,
  type Page,
  type SearchMode,
  type UploadDocumentResponse,
} from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, NotebookPen, Search, ShieldAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, ErrorBox, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { canWrite, useCurrentOrg } from '@/lib/hooks';
import { cn } from '@/lib/utils';

function UploadZone({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const results: UploadDocumentResponse[] = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 10 MB`);
        const form = new FormData();
        form.append('file', file);
        results.push(
          await api<UploadDocumentResponse>(`/projects/${projectId}/documents`, { body: form }),
        );
      }
      return results;
    },
    onSuccess: async (results) => {
      for (const r of results)
        toast.success(
          r.duplicate
            ? `${r.document.title} was already uploaded`
            : `Uploaded ${r.document.title}; indexing…`,
        );
      await queryClient.invalidateQueries({ queryKey: ['documents', projectId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pick = (list: FileList | null) => {
    if (list && list.length > 0) upload.mutate(Array.from(list));
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pick(e.dataTransfer.files);
      }}
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
        dragging ? 'border-primary bg-primary-soft' : 'border-border bg-subtle',
      )}
    >
      <Upload className="mb-2 size-5 text-muted-foreground" />
      <p className="text-sm font-medium">Drop files here or choose them</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {SUPPORTED_UPLOAD_EXTENSIONS.join(', ')} · up to 10 MB · type checked by content, not just
        extension
      </p>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
        onChange={(e) => pick(e.target.files)}
      />
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => input.current?.click()}
        loading={upload.isPending}
      >
        Choose files
      </Button>
    </div>
  );
}

function SearchPlayground({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const search = useMutation({
    mutationFn: () =>
      api<KnowledgeSearchResponse>(`/projects/${projectId}/knowledge/search`, {
        body: { query, mode, topK: 6 },
      }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="size-4" /> Retrieval playground
        </CardTitle>
        <CardDescription>
          See exactly which passages an agent would retrieve for a question, and why they ranked.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) search.mutate();
          }}
        >
          <Input
            placeholder="e.g. who approves refunds above 500 EUR"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={mode}
              onChange={(e) => setMode(e.target.value as SearchMode)}
              aria-label="Search mode"
            >
              <option value="hybrid">Hybrid (vector + keyword)</option>
              <option value="vector">Vector only</option>
              <option value="keyword">Keyword only</option>
            </Select>
            <Button type="submit" loading={search.isPending}>
              Search
            </Button>
          </div>
        </form>
        {search.data ? (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              {search.data.results.length} results in {search.data.tookMs} ms · embeddings:{' '}
              {search.data.embeddingModel} · fused with Reciprocal Rank Fusion
            </p>
            {search.data.results.map((r, i) => (
              <div key={r.chunkId} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold">#{i + 1}</span>
                  <Link
                    className="font-medium text-primary"
                    href={`/p/${projectId}/documents/${r.documentId}`}
                  >
                    {r.documentTitle}
                  </Link>
                  {r.headingPath ? (
                    <span className="text-muted-foreground">› {r.headingPath}</span>
                  ) : null}
                  <span className="ml-auto font-mono text-muted-foreground">
                    rrf {r.score.toFixed(4)} · vec {r.vectorRank ?? '–'} · kw {r.keywordRank ?? '–'}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-4 text-muted-foreground">{r.content}</p>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function DocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { role } = useCurrentOrg();
  const documents = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => api<Page<DocumentDto>>(`/projects/${projectId}/documents?limit=100`),
    refetchInterval: (query) =>
      query.state.data?.data.some((d) => !['indexed', 'failed'].includes(d.status)) ? 2_000 : false,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-4">
        {canWrite(role) ? <UploadZone projectId={projectId} /> : null}
        {documents.isError ? <ErrorBox error={documents.error} /> : null}
        {!documents.data ? (
          <Skeleton className="h-64" />
        ) : documents.data.data.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title="No documents yet"
            description="Upload Markdown, text or PDF files. Agents answer from them and cite them."
          />
        ) : (
          <Card className="divide-y divide-border">
            {documents.data.data.map((doc) => (
              <Link
                key={doc.id}
                href={`/p/${projectId}/documents/${doc.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-subtle"
              >
                <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                  {doc.kind === 'note' ? (
                    <NotebookPen className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{doc.title}</span>
                    {doc.kind === 'note' ? <Badge tone="primary">agent note</Badge> : null}
                    {doc.injectionFlags.length ? (
                      <Badge tone="warning" title={doc.injectionFlags.join(', ')}>
                        <ShieldAlert /> suspicious instructions
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {doc.mimeType.replace('text/', '').replace('application/', '')} ·{' '}
                    {bytes(doc.sizeBytes)}
                    {doc.pageCount ? ` · ${doc.pageCount} pages` : ''} · {doc.chunkCount} chunk
                    {doc.chunkCount === 1 ? '' : 's'} · {doc.uploadedBy?.name ?? 'agent'} ·{' '}
                    {timeAgo(doc.createdAt)}
                  </p>
                  {doc.errorMessage ? (
                    <p className="text-xs text-danger">{doc.errorMessage}</p>
                  ) : null}
                </div>
                <StatusBadge status={doc.status} />
              </Link>
            ))}
          </Card>
        )}
      </div>
      <div>
        <SearchPlayground projectId={projectId} />
      </div>
    </div>
  );
}
