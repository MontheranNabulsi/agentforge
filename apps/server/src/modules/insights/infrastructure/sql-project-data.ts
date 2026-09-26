import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../../platform/database/client';

export interface ProjectQuery {
  entity: 'agent_runs' | 'documents' | 'conversations' | 'tool_calls' | 'approvals';
  aggregate: 'count' | 'list';
  status?: string | undefined;
  since?: '24h' | '7d' | '30d' | 'all' | undefined;
  groupBy?: 'status' | 'day' | 'tool' | 'agent' | undefined;
  limit?: number | undefined;
}

interface EntitySpec {
  from: SQL;
  time: SQL;
  status: SQL | null;
  groups: Partial<Record<'status' | 'day' | 'tool' | 'agent', SQL>>;
  list: SQL;
}

/**
 * The project_query tool's backend: a fixed menu of queries, never model-written SQL.
 * Every identifier comes from this table; user and model input only ever reaches the query as
 * bound parameters (status value, project id) or as one of a few enum values.
 */
const ENTITIES: Record<ProjectQuery['entity'], EntitySpec> = {
  agent_runs: {
    from: sql`agent_runs t JOIN agents a ON a.id = t.agent_id`,
    time: sql`t.created_at`,
    status: sql`t.status`,
    groups: {
      status: sql`t.status`,
      day: sql`to_char(date_trunc('day', t.created_at), 'YYYY-MM-DD')`,
      agent: sql`a.name`,
    },
    list: sql`t.id, a.name AS agent, t.status, left(t.input, 80) AS input, t.created_at`,
  },
  documents: {
    from: sql`documents t`,
    time: sql`t.created_at`,
    status: sql`t.status`,
    groups: {
      status: sql`t.status`,
      day: sql`to_char(date_trunc('day', t.created_at), 'YYYY-MM-DD')`,
    },
    list: sql`t.id, t.title, t.status, t.chunk_count, t.created_at`,
  },
  conversations: {
    from: sql`conversations t JOIN agents a ON a.id = t.agent_id`,
    time: sql`t.created_at`,
    status: null,
    groups: {
      day: sql`to_char(date_trunc('day', t.created_at), 'YYYY-MM-DD')`,
      agent: sql`a.name`,
    },
    list: sql`t.id, t.title, a.name AS agent, t.created_at`,
  },
  tool_calls: {
    from: sql`tool_calls t`,
    time: sql`t.created_at`,
    status: sql`t.status`,
    groups: {
      status: sql`t.status`,
      day: sql`to_char(date_trunc('day', t.created_at), 'YYYY-MM-DD')`,
      tool: sql`t.tool_name`,
    },
    list: sql`t.id, t.tool_name, t.status, t.input_summary, t.created_at`,
  },
  approvals: {
    from: sql`approval_requests t LEFT JOIN tool_calls c ON c.id = t.tool_call_id`,
    time: sql`t.requested_at`,
    status: sql`t.status`,
    groups: {
      status: sql`t.status`,
      day: sql`to_char(date_trunc('day', t.requested_at), 'YYYY-MM-DD')`,
      tool: sql`c.tool_name`,
    },
    list: sql`t.id, t.title, t.status, t.risk_level, t.requested_at AS created_at`,
  },
};

const WINDOWS: Record<NonNullable<ProjectQuery['since']>, string | null> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};

export class SqlProjectData {
  constructor(private readonly db: Database) {}

  async metadata(projectId: string) {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT p.name, p.description, p.created_at,
        (SELECT count(*) FROM documents d WHERE d.project_id = p.id AND d.deleted_at IS NULL)::int AS document_count,
        (SELECT count(*) FROM agents a WHERE a.project_id = p.id AND a.archived_at IS NULL)::int AS agent_count,
        (SELECT count(*) FROM organization_members m WHERE m.organization_id = p.organization_id)::int AS member_count
      FROM projects p WHERE p.id = ${projectId}`);
    const r = rows[0];
    if (!r) throw new Error('Project not found');
    return {
      name: String(r.name),
      description: String(r.description ?? ''),
      documentCount: Number(r.document_count ?? 0),
      agentCount: Number(r.agent_count ?? 0),
      memberCount: Number(r.member_count ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async query(projectId: string, query: ProjectQuery): Promise<unknown> {
    const spec = ENTITIES[query.entity];
    const where: SQL[] = [sql`t.project_id = ${projectId}`];
    if (query.entity === 'documents') where.push(sql`t.deleted_at IS NULL`);
    const window = WINDOWS[query.since ?? '7d'];
    if (window) where.push(sql`${spec.time} > now() - ${window}::interval`);
    if (query.status) {
      if (!spec.status)
        return { error: 'NO_STATUS', message: `${query.entity} have no status to filter by` };
      where.push(sql`${spec.status} = ${query.status}`);
    }
    const condition = sql.join(where, sql` AND `);
    const base = {
      entity: query.entity,
      since: query.since ?? '7d',
      ...(query.status ? { status: query.status } : {}),
    };

    if (query.aggregate === 'list') {
      const limit = Math.min(Math.max(query.limit ?? 10, 1), 20);
      const { rows } = await this.db.execute<Record<string, unknown>>(
        sql`SELECT ${spec.list} FROM ${spec.from} WHERE ${condition} ORDER BY ${spec.time} DESC LIMIT ${limit}`,
      );
      return { ...base, rows: rows.map((row) => normalize(row)) };
    }

    if (query.groupBy) {
      const group = spec.groups[query.groupBy];
      if (!group)
        return {
          error: 'UNSUPPORTED_GROUPING',
          message: `${query.entity} cannot be grouped by ${query.groupBy}`,
        };
      const { rows } = await this.db.execute<{ key: string | null; count: number }>(
        sql`SELECT ${group} AS key, count(*)::int AS count FROM ${spec.from} WHERE ${condition} GROUP BY 1 ORDER BY 2 DESC LIMIT 31`,
      );
      return {
        ...base,
        groupBy: query.groupBy,
        groups: rows.map((r) => ({ key: r.key ?? 'none', count: Number(r.count) })),
      };
    }

    const { rows } = await this.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ${spec.from} WHERE ${condition}`,
    );
    return { ...base, count: Number(rows[0]?.count ?? 0) };
  }
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
}
