'use client';

import type { SystemStatusDto } from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, Server, Sparkles } from 'lucide-react';
import { Stat } from '@/components/stat';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';

export default function SystemPage() {
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api<SystemStatusDto>('/system/status'),
    refetchInterval: 5_000,
  });
  if (status.isError) return <ErrorBox error={status.error} />;
  const s = status.data;
  const hours = s ? Math.floor(s.uptimeSeconds / 3600) : 0;
  return (
    <>
      <PageHeader
        title="System status"
        description="Health of the pieces behind this deployment, refreshed every 5 seconds."
      />
      {!s ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Version"
              icon={<Server />}
              value={s.version}
              hint={`up ${hours}h ${Math.floor((s.uptimeSeconds % 3600) / 60)}m`}
            />
            <Stat
              label="PostgreSQL"
              icon={<Database />}
              value={s.database.ok ? 'healthy' : 'down'}
              hint={s.database.latencyMs !== null ? `${s.database.latencyMs} ms ping` : undefined}
            />
            <Stat
              label="Redis"
              icon={<Cpu />}
              value={s.redis.ok ? 'healthy' : 'down'}
              hint={s.redis.latencyMs !== null ? `${s.redis.latencyMs} ms ping` : undefined}
            />
            <Stat
              label="Language model"
              icon={<Sparkles />}
              value={<span className="text-base">{s.ai.demoMode ? 'Demo model' : s.ai.model}</span>}
              hint={
                s.ai.demoMode
                  ? 'Deterministic, offline. Set ANTHROPIC_API_KEY for Claude.'
                  : `${s.ai.llmProvider}`
              }
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Background queues</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 font-medium">Queue</th>
                    <th className="px-3 py-2 text-right font-medium">Waiting</th>
                    <th className="px-3 py-2 text-right font-medium">Active</th>
                    <th className="px-3 py-2 text-right font-medium">Delayed (retry)</th>
                    <th className="px-5 py-2 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {s.queues.map((q) => (
                    <tr key={q.name}>
                      <td className="px-5 py-2 font-mono text-xs">{q.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{q.waiting}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{q.active}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{q.delayed}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{q.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-5 pt-3 text-xs text-muted-foreground">
                Dead-letter queue:{' '}
                <Badge tone={s.deadLetters ? 'warning' : 'neutral'}>{s.deadLetters} jobs</Badge> ·
                Embeddings: {s.ai.embeddingProvider} ({s.ai.embeddingModel})
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
