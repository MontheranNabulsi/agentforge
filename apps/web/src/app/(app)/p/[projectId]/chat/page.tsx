'use client';

import type { AgentDto, ConversationDto, Page, SendMessageResponse } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MessageSquare, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/input';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage, idempotencyKey } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canWrite, useCurrentOrg } from '@/lib/hooks';
import { SUGGESTIONS } from '@/lib/suggestions';

export default function ChatIndexPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useCurrentOrg();
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState('');
  const conversations = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => api<Page<ConversationDto>>(`/projects/${projectId}/conversations?limit=50`),
  });
  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<AgentDto[]>(`/projects/${projectId}/agents`),
  });

  const start = useMutation({
    mutationFn: async (content: string) => {
      const conversation = await api<ConversationDto>(`/projects/${projectId}/conversations`, {
        body: agentId ? { agentId } : {},
      });
      await api<SendMessageResponse>(`/conversations/${conversation.id}/messages`, {
        body: { content },
        headers: { 'idempotency-key': idempotencyKey() },
      });
      return conversation;
    },
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ['conversations', projectId] });
      router.push(`/p/${projectId}/chat/${conversation.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const writable = canWrite(role);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-medium">
              <Bot className="size-4 text-primary" /> Ask an agent
            </h2>
            {agents.data && agents.data.length > 1 ? (
              <Select
                className="h-8 w-56"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                aria-label="Agent"
              >
                <option value="">
                  {agents.data.find((a) => a.isDefault)?.name ?? 'Default agent'} (default)
                </option>
                {agents.data
                  .filter((a) => !a.isDefault)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            ) : null}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) start.mutate(text.trim());
            }}
          >
            <Textarea
              rows={3}
              placeholder={
                writable
                  ? 'Ask about the project’s documents, or give the agent a task…'
                  : 'Viewers can read conversations but not start them.'
              }
              value={text}
              disabled={!writable}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                  e.preventDefault();
                  start.mutate(text.trim());
                }
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Enter to send · Shift+Enter for a new line
              </p>
              <Button type="submit" loading={start.isPending} disabled={!writable || !text.trim()}>
                <Send /> Start conversation
              </Button>
            </div>
          </form>
          {writable ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => start.mutate(s)}
                  disabled={start.isPending}
                  className="rounded-full border border-border bg-subtle px-3 py-1 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Conversations</h2>
        {!conversations.data ? (
          <Skeleton className="h-48" />
        ) : conversations.data.data.length === 0 ? (
          <EmptyState
            icon={<MessageSquare />}
            title="No conversations yet"
            description="Start one on the left."
          />
        ) : (
          <div className="space-y-1.5">
            {conversations.data.data.map((c) => (
              <Link
                key={c.id}
                href={`/p/${projectId}/chat/${c.id}`}
                className="block rounded-lg border border-border bg-card px-3 py-2 hover:border-primary/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{c.title}</span>
                  {c.activeRunId ? <Badge tone="info">working</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.agentName} · {c.messageCount} messages ·{' '}
                  {timeAgo(c.lastMessageAt ?? c.createdAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
