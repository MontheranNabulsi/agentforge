import { z } from 'zod';
import { AuditEventDto } from './audit';
import { Id, Role, Timestamp } from './common';

export const ProjectCardDto = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  documentCount: z.number().int(),
  conversationCount: z.number().int(),
  runCount7d: z.number().int(),
  lastActivityAt: Timestamp.nullable(),
});
export type ProjectCardDto = z.infer<typeof ProjectCardDto>;

export const OrganizationOverviewDto = z.object({
  organization: z.object({ id: Id, name: z.string(), slug: z.string(), role: Role }),
  memberCount: z.number().int(),
  pendingApprovals: z.number().int(),
  projects: z.array(ProjectCardDto),
  recentActivity: z.array(AuditEventDto),
});
export type OrganizationOverviewDto = z.infer<typeof OrganizationOverviewDto>;

export const RunsPerDayDto = z.object({
  date: z.string(),
  completed: z.number().int(),
  failed: z.number().int(),
  other: z.number().int(),
});
export type RunsPerDayDto = z.infer<typeof RunsPerDayDto>;

export const ProjectStatsDto = z.object({
  documents: z.object({
    total: z.number().int(),
    indexed: z.number().int(),
    processing: z.number().int(),
    failed: z.number().int(),
  }),
  conversations: z.number().int(),
  agents: z.number().int(),
  runs7d: z.number().int(),
  successRate7d: z.number().nullable(),
  p50DurationMs7d: z.number().nullable(),
  p95DurationMs7d: z.number().nullable(),
  tokens7d: z.number().int(),
  pendingApprovals: z.number().int(),
  latestEvaluation: z
    .object({
      id: Id,
      datasetName: z.string(),
      passRate: z.number(),
      previousPassRate: z.number().nullable(),
      completedAt: Timestamp,
    })
    .nullable(),
});
export type ProjectStatsDto = z.infer<typeof ProjectStatsDto>;

export const RecentRunDto = z.object({
  id: Id,
  agentName: z.string(),
  status: z.string(),
  intent: z.string().nullable(),
  inputPreview: z.string(),
  durationMs: z.number().int().nullable(),
  totalTokens: z.number().int(),
  createdAt: Timestamp,
});
export type RecentRunDto = z.infer<typeof RecentRunDto>;

export const ProjectOverviewDto = z.object({
  project: z.object({
    id: Id,
    organizationId: Id,
    name: z.string(),
    slug: z.string(),
    description: z.string(),
  }),
  role: Role,
  stats: ProjectStatsDto,
  runsPerDay: z.array(RunsPerDayDto),
  recentRuns: z.array(RecentRunDto),
  recentConversations: z.array(
    z.object({ id: Id, title: z.string(), lastMessageAt: Timestamp.nullable() }),
  ),
  recentActivity: z.array(AuditEventDto),
  cachedAt: Timestamp,
});
export type ProjectOverviewDto = z.infer<typeof ProjectOverviewDto>;

export const SystemStatusDto = z.object({
  version: z.string(),
  uptimeSeconds: z.number().int(),
  database: z.object({ ok: z.boolean(), latencyMs: z.number().nullable() }),
  redis: z.object({ ok: z.boolean(), latencyMs: z.number().nullable() }),
  queues: z.array(
    z.object({
      name: z.string(),
      waiting: z.number().int(),
      active: z.number().int(),
      delayed: z.number().int(),
      failed: z.number().int(),
    }),
  ),
  deadLetters: z.number().int(),
  ai: z.object({
    llmProvider: z.string(),
    model: z.string(),
    embeddingProvider: z.string(),
    embeddingModel: z.string(),
    demoMode: z.boolean(),
  }),
});
export type SystemStatusDto = z.infer<typeof SystemStatusDto>;
