'use client';

import type {
  ApprovalDto,
  ConversationDto,
  MessageDto,
  RunEvent,
  SendMessageResponse,
} from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CircleStop,
  ListChecks,
  Send,
  ThumbsDown,
  ThumbsUp,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApprovalCard } from '@/components/approval-card';
import { Citations } from '@/components/citations';
import { Markdown } from '@/components/markdown';
import { RunTimeline, TERMINAL, useLiveRun } from '@/components/run-timeline';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { ErrorBox, Skeleton, Spinner } from '@/components/ui/misc';
import { api, errorMessage, idempotencyKey } from '@/lib/api';
import { duration, timeAgo } from '@/lib/format';
import { canWrite, useCurrentOrg } from '@/lib/hooks';
import { SUGGESTIONS } from '@/lib/suggestions';
import { cn } from '@/lib/utils';

function Feedback({ message }: { message: MessageDto }) {
  const queryClient = useQueryClient();
  const rate = useMutation({
    mutationFn: (rating: 1 | -1) =>
      api<MessageDto>(`/messages/${message.id}/feedback`, { method: 'PUT', body: { rating } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['messages', message.conversationId] }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Helpful"
        onClick={() => rate.mutate(1)}
        className={cn(message.myFeedback === 1 && 'text-success')}
      >
        <ThumbsUp className="!size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Not helpful"
        onClick={() => rate.mutate(-1)}
        className={cn(message.myFeedback === -1 && 'text-danger')}
      >
        <ThumbsDown className="!size-3.5" />
      </Button>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
      <Bot className="size-4" />
    </span>
  );
}

function MessageBubble({
  message,
  projectId,
  onInspect,
}: {
  message: MessageDto;
  projectId: string;
  onInspect: (runId: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
          {message.content}
        </div>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User className="size-4" />
        </span>
      </div>
    );
  }
  const prefix = `cite-${message.id.slice(-6)}`;
  const structured = message.structuredOutput !== null && message.structuredOutput !== undefined;
  return (
    <div className="flex gap-3">
      <AssistantAvatar />
      <div className="min-w-0 max-w-[92%] flex-1">
        <div
          className={cn(
            'rounded-2xl rounded-tl-sm border bg-card px-4 py-3',
            message.status === 'failed' ? 'border-danger/30' : 'border-border',
          )}
        >
          {structured ? (
            <pre className="overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
              {JSON.stringify(message.structuredOutput, null, 2)}
            </pre>
          ) : (
            <Markdown
              text={message.content}
              citationPrefix={prefix}
              className={cn(message.status === 'failed' && 'text-danger')}
            />
          )}
          <Citations citations={message.citations} projectId={projectId} prefix={prefix} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{timeAgo(message.createdAt)}</span>
          {message.validation ? <StatusBadge status={message.validation.status} /> : null}
          {structured ? <Badge tone="info">structured output</Badge> : null}
          {message.runId ? (
            <button
              className="flex items-center gap-1 hover:text-foreground"
              onClick={() => onInspect(message.runId!)}
            >
              <ListChecks className="size-3.5" /> How this was answered
            </button>
          ) : null}
          <span className="ml-auto">
            <Feedback message={message} />
          </span>
        </div>
      </div>
    </div>
  );
}

function PendingApproval({ approvalId, canDecide }: { approvalId: string; canDecide: boolean }) {
  const approval = useQuery({
    queryKey: ['approval', approvalId],
    queryFn: () => api<ApprovalDto>(`/approvals/${approvalId}`),
  });
  if (!approval.data) return <Skeleton className="h-32" />;
  return (
    <ApprovalCard
      approval={approval.data}
      canDecide={canDecide}
      compact
      onDecided={() => void approval.refetch()}
    />
  );
}

export default function ConversationPage() {
  const { projectId, conversationId } = useParams<{ projectId: string; conversationId: string }>();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const [text, setText] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [inspectRunId, setInspectRunId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api<ConversationDto>(`/conversations/${conversationId}`),
  });
  const messages = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api<MessageDto[]>(`/conversations/${conversationId}/messages`),
  });

  // Reattach to a run that was already working when the page opened.
  useEffect(() => {
    if (conversation.data?.activeRunId)
      setActiveRunId((current) => current ?? conversation.data!.activeRunId);
  }, [conversation.data]);

  const onTerminal = (event: RunEvent) => {
    void queryClient
      .invalidateQueries({ queryKey: ['messages', conversationId] })
      .then(() => setActiveRunId(null));
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    void queryClient.invalidateQueries({ queryKey: ['conversations', projectId] });
    if (event.type === 'run.failed' && event.status !== 'cancelled') toast.error(event.message);
  };
  const live = useLiveRun(activeRunId, onTerminal);
  const shownRunId =
    inspectRunId ??
    activeRunId ??
    [...(messages.data ?? [])].reverse().find((m) => m.runId)?.runId ??
    null;
  const panel = useLiveRun(shownRunId === activeRunId ? null : shownRunId);
  const panelRun = shownRunId === activeRunId ? live.detail.data : panel.detail.data;

  const send = useMutation({
    mutationFn: (content: string) =>
      api<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
        body: { content },
        headers: { 'idempotency-key': idempotencyKey() },
      }),
    onSuccess: (response) => {
      setText('');
      setInspectRunId(null);
      queryClient.setQueryData<MessageDto[]>(['messages', conversationId], (old) => [
        ...(old ?? []),
        response.message,
      ]);
      setActiveRunId(response.run.id);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/runs/${activeRunId}/cancel`, { method: 'POST' }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const run = live.detail.data;
  const waitingApproval =
    run?.status === 'awaiting_approval'
      ? run.toolCalls.find((c) => c.status === 'awaiting_approval' && c.approvalId)
      : undefined;
  const busy = Boolean(activeRunId) && (live.live || !run || !TERMINAL.includes(run.status));
  const writable = canWrite(role);
  const count = messages.data?.length ?? 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [count, live.streamText.length, waitingApproval?.id]);

  const lastStep = useMemo(
    () => run?.steps.filter((s) => s.status === 'running').at(-1) ?? run?.steps.at(-1),
    [run],
  );

  return (
    <div className="grid h-full min-h-[70vh] gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-h-0 flex-col rounded-xl border border-border bg-subtle">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Link
            href={`/p/${projectId}/chat`}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="All conversations"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{conversation.data?.title ?? '…'}</p>
            <p className="text-xs text-muted-foreground">
              with {conversation.data?.agentName ?? 'agent'}
            </p>
          </div>
          {run?.provider === 'fake' ? (
            <Badge tone="outline">deterministic demo model</Badge>
          ) : run?.model ? (
            <Badge tone="outline">{run.model}</Badge>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
          {messages.isError ? <ErrorBox error={messages.error} /> : null}
          {!messages.data ? <Skeleton className="h-24" /> : null}
          {messages.data?.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              projectId={projectId}
              onInspect={setInspectRunId}
            />
          ))}
          {messages.data && messages.data.length === 0 && !busy ? (
            <div className="mx-auto max-w-lg py-10 text-center">
              <p className="text-sm text-muted-foreground">Try one of these:</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.slice(0, 4).map((s) => (
                  <button
                    key={s}
                    onClick={() => send.mutate(s)}
                    className="rounded-full border border-border bg-card px-3 py-1 text-xs hover:border-primary/40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {busy ? (
            <div className="flex gap-3">
              <AssistantAvatar />
              <div className="min-w-0 flex-1 space-y-3">
                {live.streamText ? (
                  <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
                    <Markdown text={live.streamText} className="streaming-caret" />
                  </div>
                ) : (
                  <div className="rounded-2xl rounded-tl-sm border border-dashed border-border bg-card px-4 py-3">
                    <Spinner
                      label={
                        lastStep
                          ? `${lastStep.name}${lastStep.summary ? ` — ${lastStep.summary}` : '…'}`
                          : 'Queued…'
                      }
                    />
                  </div>
                )}
                {waitingApproval?.approvalId ? (
                  <div>
                    <p className="mb-2 text-xs font-medium text-warning">
                      The agent is waiting for approval before it continues.
                    </p>
                    <PendingApproval approvalId={waitingApproval.approvalId} canDecide={writable} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div ref={bottom} />
        </div>

        <form
          className="border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy) send.mutate(text.trim());
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              rows={1}
              className="max-h-40 min-h-10 resize-none bg-card"
              placeholder={
                !writable
                  ? 'Viewers cannot send messages'
                  : busy
                    ? 'The agent is working…'
                    : 'Message the agent'
              }
              value={text}
              disabled={!writable}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim() && !busy) send.mutate(text.trim());
                }
              }}
            />
            {busy ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => cancel.mutate()}
                loading={cancel.isPending}
                aria-label="Stop the run"
              >
                <CircleStop /> Stop
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!writable || !text.trim()}
                loading={send.isPending}
                aria-label="Send"
              >
                <Send />
              </Button>
            )}
          </div>
        </form>
      </div>

      <aside className="hidden min-h-0 flex-col rounded-xl border border-border bg-card lg:flex">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <p className="text-sm font-medium">Execution</p>
            <p className="text-xs text-muted-foreground">
              {inspectRunId ? 'Selected answer' : busy ? 'Live' : 'Latest run'}
            </p>
          </div>
          {panelRun ? <StatusBadge status={panelRun.status} /> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {panelRun ? (
            <>
              <div className="mb-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-subtle p-2">
                  <div className="font-semibold tabular-nums">{panelRun.intent ?? '—'}</div>
                  <div className="text-muted-foreground">intent</div>
                </div>
                <div className="rounded-lg bg-subtle p-2">
                  <div className="font-semibold tabular-nums">{panelRun.totalTokens}</div>
                  <div className="text-muted-foreground">tokens</div>
                </div>
                <div className="rounded-lg bg-subtle p-2">
                  <div className="font-semibold tabular-nums">{duration(panelRun.durationMs)}</div>
                  <div className="text-muted-foreground">duration</div>
                </div>
              </div>
              <RunTimeline run={panelRun} dense />
              <Link
                href={`/runs/${panelRun.id}`}
                className="mt-4 block text-center text-xs text-primary"
              >
                Open in run inspector →
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Send a message to see each step the agent takes: classification, planning, retrieval,
              tool calls, approvals and validation.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
