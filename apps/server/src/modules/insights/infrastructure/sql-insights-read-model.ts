import type {
  ProjectCardDto,
  ProjectOverviewDto,
  RecentRunDto,
  RunsPerDayDto,
} from '@agentforge/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../../../platform/database/client';
import type { InsightsReadModel } from '../application/insights-queries';

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value));

/** Hand-written SQL on purpose: these are reporting queries, easier to read and EXPLAIN as SQL. */
export class SqlInsightsReadModel implements InsightsReadModel {
  constructor(private readonly db: Database) {}

  async projectCards(organizationId: string): Promise<ProjectCardDto[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT p.id, p.name, p.slug, p.description,
        (SELECT count(*) FROM documents d WHERE d.project_id = p.id AND d.deleted_at IS NULL)::int AS document_count,
        (SELECT count(*) FROM conversations c WHERE c.project_id = p.id)::int AS conversation_count,
        (SELECT count(*) FROM agent_runs r
           WHERE r.project_id = p.id AND r.created_at > now() - interval '7 days')::int AS run_count_7d,
        GREATEST(p.updated_at, (SELECT max(a.created_at) FROM audit_events a WHERE a.project_id = p.id)) AS last_activity_at
      FROM projects p
      WHERE p.organization_id = ${organizationId} AND p.archived_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT 60`);
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
      description: String(r.description ?? ''),
      documentCount: num(r.document_count),
      conversationCount: num(r.conversation_count),
      runCount7d: num(r.run_count_7d),
      lastActivityAt: iso(r.last_activity_at as Date | null),
    }));
  }

  async memberCount(organizationId: string): Promise<number> {
    const { rows } = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = ${organizationId}`,
    );
    return num(rows[0]?.n);
  }

  async pendingApprovals(
    scope: { organizationId: string } | { projectId: string },
  ): Promise<number> {
    const where =
      'organizationId' in scope
        ? sql`organization_id = ${scope.organizationId}`
        : sql`project_id = ${scope.projectId}`;
    const { rows } = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM approval_requests WHERE status = 'pending' AND ${where}`,
    );
    return num(rows[0]?.n);
  }

  async projectStats(projectId: string): Promise<ProjectOverviewDto['stats']> {
    const [documents, runs, evaluation, counts, approvals] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE status = 'indexed')::int AS indexed,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status NOT IN ('indexed', 'failed'))::int AS processing
        FROM documents WHERE project_id = ${projectId} AND deleted_at IS NULL`),
      this.db.execute<Record<string, unknown>>(sql`
        WITH r AS (
          SELECT status,
            EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS duration_ms,
            prompt_tokens + completion_tokens AS tokens
          FROM agent_runs
          WHERE project_id = ${projectId} AND created_at > now() - interval '7 days'
        )
        SELECT count(*)::int AS runs,
          count(*) FILTER (WHERE status = 'completed')::int AS completed,
          count(*) FILTER (WHERE status IN ('failed', 'timed_out'))::int AS failed,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p95,
          COALESCE(sum(tokens), 0)::bigint AS tokens
        FROM r`),
      this.db.execute<Record<string, unknown>>(sql`
        SELECT er.id, d.name AS dataset_name, er.passed, er.total_cases, er.completed_at,
          (SELECT prev.passed::float / NULLIF(prev.total_cases, 0)
             FROM evaluation_runs prev
             WHERE prev.dataset_id = er.dataset_id AND prev.status = 'completed' AND prev.completed_at < er.completed_at
             ORDER BY prev.completed_at DESC LIMIT 1) AS previous_pass_rate
        FROM evaluation_runs er
        JOIN evaluation_datasets d ON d.id = er.dataset_id
        WHERE er.project_id = ${projectId} AND er.status = 'completed'
        ORDER BY er.completed_at DESC
        LIMIT 1`),
      this.db.execute<Record<string, unknown>>(sql`
        SELECT (SELECT count(*) FROM conversations WHERE project_id = ${projectId})::int AS conversations,
               (SELECT count(*) FROM agents WHERE project_id = ${projectId} AND archived_at IS NULL)::int AS agents`),
      this.pendingApprovals({ projectId }),
    ]);
    const d = documents.rows[0] ?? {};
    const r = runs.rows[0] ?? {};
    const e = evaluation.rows[0];
    const c = counts.rows[0] ?? {};
    const completed = num(r.completed);
    const failed = num(r.failed);
    return {
      documents: {
        total: num(d.total),
        indexed: num(d.indexed),
        processing: num(d.processing),
        failed: num(d.failed),
      },
      conversations: num(c.conversations),
      agents: num(c.agents),
      runs7d: num(r.runs),
      successRate7d: completed + failed > 0 ? completed / (completed + failed) : null,
      p50DurationMs7d: numOrNull(r.p50),
      p95DurationMs7d: numOrNull(r.p95),
      tokens7d: num(r.tokens),
      pendingApprovals: approvals,
      latestEvaluation: e
        ? {
            id: String(e.id),
            datasetName: String(e.dataset_name),
            passRate: num(e.total_cases) > 0 ? num(e.passed) / num(e.total_cases) : 0,
            previousPassRate: e.previous_pass_rate === null ? null : Number(e.previous_pass_rate),
            completedAt: iso(e.completed_at as Date)!,
          }
        : null,
    };
  }

  async runsPerDay(projectId: string, days: number): Promise<RunsPerDayDto[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS date,
        count(r.id) FILTER (WHERE r.status = 'completed')::int AS completed,
        count(r.id) FILTER (WHERE r.status IN ('failed', 'timed_out'))::int AS failed,
        count(r.id) FILTER (WHERE r.status NOT IN ('completed', 'failed', 'timed_out'))::int AS other
      FROM generate_series(
        date_trunc('day', now()) - make_interval(days => ${days - 1}),
        date_trunc('day', now()),
        interval '1 day') AS day
      LEFT JOIN agent_runs r
        ON r.project_id = ${projectId} AND r.created_at >= day AND r.created_at < day + interval '1 day'
      GROUP BY day
      ORDER BY day`);
    return rows.map((r) => ({
      date: String(r.date),
      completed: num(r.completed),
      failed: num(r.failed),
      other: num(r.other),
    }));
  }

  async recentRuns(projectId: string, limit: number): Promise<RecentRunDto[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT r.id, a.name AS agent_name, r.status, r.intent, left(r.input, 140) AS input_preview,
        CASE WHEN r.completed_at IS NOT NULL AND r.started_at IS NOT NULL
             THEN (EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int END AS duration_ms,
        (r.prompt_tokens + r.completion_tokens)::int AS total_tokens,
        r.created_at
      FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      WHERE r.project_id = ${projectId}
      ORDER BY r.created_at DESC
      LIMIT ${limit}`);
    return rows.map((r) => ({
      id: String(r.id),
      agentName: String(r.agent_name),
      status: String(r.status),
      intent: r.intent === null ? null : String(r.intent),
      inputPreview: String(r.input_preview ?? ''),
      durationMs: numOrNull(r.duration_ms),
      totalTokens: num(r.total_tokens),
      createdAt: iso(r.created_at as Date)!,
    }));
  }

  async recentConversations(projectId: string, limit: number) {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT id, title, last_message_at FROM conversations
      WHERE project_id = ${projectId}
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT ${limit}`);
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      lastMessageAt: iso(r.last_message_at as Date | null),
    }));
  }
}
