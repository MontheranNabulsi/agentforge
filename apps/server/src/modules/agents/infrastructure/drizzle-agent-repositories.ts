import type {
  AgentLimits,
  Page,
  Plan,
  RetrievalSettings,
  RunError,
  RunOutput,
  RunTrigger,
  ToolCallStatus,
  ToolGrant,
} from '@agentforge/contracts';
import { and, asc, count, desc, eq, inArray, lt, or, sql, sum, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  agentRunSteps,
  agentRuns,
  agents,
  agentVersions,
  approvalRequests,
  projects,
  toolCalls,
  users,
} from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { isUniqueViolation } from '../../../platform/database/errors';
import { executor } from '../../../platform/database/transaction';
import type { ModelProfile } from '../../../shared-kernel/ai';
import { conflict } from '../../../shared-kernel/errors';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type { RiskLevel } from '../domain/approval-policy';
import { ACTIVE_STATUSES, type RunIntent, type RunStatus } from '../domain/run-rules';
import type {
  AgentRecord,
  AgentRepository,
  AgentVersionRecord,
  AgentWithVersion,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalStatus,
  NewRun,
  RunListFilter,
  RunRecord,
  RunRepository,
  StepKind,
  StepRecord,
  StepRepository,
  StepStatus,
  ToolCallRecord,
  ToolCallRepository,
} from '../application/ports';

// =======================================================================================
// Agents
// =======================================================================================

type VersionRow = typeof agentVersions.$inferSelect;

const toVersion = (row: VersionRow, createdByName: string | null): AgentVersionRecord => ({
  ...row,
  modelProfile: row.modelProfile as ModelProfile,
  tools: row.tools as ToolGrant[],
  limits: row.limits as AgentLimits,
  retrieval: row.retrieval as RetrievalSettings,
  outputSchema: row.outputSchema ?? null,
  createdByName,
});

export class DrizzleAgentRepository implements AgentRepository {
  constructor(private readonly db: Database) {}

  async create(
    agent: AgentRecord,
    version: Omit<AgentVersionRecord, 'createdByName'>,
  ): Promise<void> {
    const q = executor(this.db);
    await q.insert(agents).values(agent);
    await q.insert(agentVersions).values(version);
  }

  private async withVersions(rows: (typeof agents.$inferSelect)[]): Promise<AgentWithVersion[]> {
    if (rows.length === 0) return [];
    const latest = await executor(this.db)
      .selectDistinctOn([agentVersions.agentId], {
        version: agentVersions,
        createdByName: users.name,
      })
      .from(agentVersions)
      .leftJoin(users, eq(users.id, agentVersions.createdBy))
      .where(
        inArray(
          agentVersions.agentId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(agentVersions.agentId, desc(agentVersions.version));
    const byAgent = new Map(
      latest.map((l) => [l.version.agentId, toVersion(l.version, l.createdByName)]),
    );
    return rows.flatMap((row) => {
      const currentVersion = byAgent.get(row.id);
      return currentVersion ? [{ ...row, currentVersion }] : [];
    });
  }

  async findById(id: string): Promise<AgentWithVersion | null> {
    const rows = await executor(this.db).select().from(agents).where(eq(agents.id, id)).limit(1);
    return (await this.withVersions(rows))[0] ?? null;
  }

  async findDefault(projectId: string): Promise<AgentWithVersion | null> {
    const rows = await executor(this.db)
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.projectId, projectId),
          eq(agents.isDefault, true),
          sql`${agents.archivedAt} IS NULL`,
        ),
      )
      .limit(1);
    return (await this.withVersions(rows))[0] ?? null;
  }

  async list(projectId: string): Promise<AgentWithVersion[]> {
    const rows = await executor(this.db)
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), sql`${agents.archivedAt} IS NULL`))
      .orderBy(desc(agents.isDefault), asc(agents.createdAt));
    return this.withVersions(rows);
  }

  async slugExists(projectId: string, slug: string): Promise<boolean> {
    const rows = await executor(this.db)
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.slug, slug)))
      .limit(1);
    return rows.length > 0;
  }

  async addVersion(version: Omit<AgentVersionRecord, 'createdByName'>): Promise<void> {
    try {
      await executor(this.db).insert(agentVersions).values(version);
    } catch (error) {
      if (isUniqueViolation(error, 'agent_versions_agent_version_unique')) {
        throw Object.assign(new Error('Concurrent agent edit'), { code: 'AGENT_VERSION_CONFLICT' });
      }
      throw error;
    }
  }

  async update(
    id: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'description' | 'isDefault' | 'archivedAt'>>,
    now: Date,
  ): Promise<void> {
    await executor(this.db)
      .update(agents)
      .set({ ...patch, updatedAt: now })
      .where(eq(agents.id, id));
  }

  async clearDefault(projectId: string): Promise<void> {
    await executor(this.db)
      .update(agents)
      .set({ isDefault: false })
      .where(and(eq(agents.projectId, projectId), eq(agents.isDefault, true)));
  }

  async listVersions(agentId: string): Promise<AgentVersionRecord[]> {
    const rows = await executor(this.db)
      .select({ version: agentVersions, createdByName: users.name })
      .from(agentVersions)
      .leftJoin(users, eq(users.id, agentVersions.createdBy))
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(desc(agentVersions.version));
    return rows.map((r) => toVersion(r.version, r.createdByName));
  }

  async findVersion(versionId: string): Promise<AgentVersionRecord | null> {
    const [row] = await executor(this.db)
      .select({ version: agentVersions, createdByName: users.name })
      .from(agentVersions)
      .leftJoin(users, eq(users.id, agentVersions.createdBy))
      .where(eq(agentVersions.id, versionId))
      .limit(1);
    return row ? toVersion(row.version, row.createdByName) : null;
  }
}

// =======================================================================================
// Runs
// =======================================================================================

type RunRow = typeof agentRuns.$inferSelect;

const toRun = (row: RunRow, agentName: string, agentVersion: number): RunRecord => ({
  ...row,
  trigger: row.trigger as RunTrigger,
  status: row.status as RunStatus,
  intent: (row.intent as RunIntent | null) ?? null,
  plan: (row.plan as Plan | null) ?? null,
  output: (row.output as RunOutput | null) ?? null,
  error: (row.error as RunError | null) ?? null,
  history: row.history as RunRecord['history'],
  agentName,
  agentVersion,
});

/** Only real columns may be written; derived fields (agentName, agentVersion) are dropped. */
function runColumns(patch: Partial<RunRecord>): Partial<typeof agentRuns.$inferInsert> {
  const { agentName: _n, agentVersion: _v, updatedAt: _u, ...rest } = patch;
  return rest as Partial<typeof agentRuns.$inferInsert>;
}

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select({ run: agentRuns, agentName: agents.name, agentVersion: agentVersions.version })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .innerJoin(agentVersions, eq(agentVersions.id, agentRuns.agentVersionId));
  }

  async create(run: NewRun): Promise<void> {
    try {
      await executor(this.db)
        .insert(agentRuns)
        .values(runColumns(run as Partial<RunRecord>) as typeof agentRuns.$inferInsert);
    } catch (error) {
      if (isUniqueViolation(error, 'agent_runs_one_active_per_conversation')) {
        throw conflict(
          'RUN_IN_PROGRESS',
          'The agent is still working on the previous message in this conversation',
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<RunRecord | null> {
    const [row] = await this.select().where(eq(agentRuns.id, id)).limit(1);
    return row ? toRun(row.run, row.agentName, row.agentVersion) : null;
  }

  async list(filter: RunListFilter): Promise<Page<RunRecord>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(agentRuns.projectId, filter.projectId)];
    if (filter.status) conditions.push(eq(agentRuns.status, filter.status));
    if (filter.agentId) conditions.push(eq(agentRuns.agentId, filter.agentId));
    if (filter.trigger) conditions.push(eq(agentRuns.trigger, filter.trigger));
    if (cursor) {
      conditions.push(
        or(
          lt(agentRuns.createdAt, cursor.createdAt),
          and(eq(agentRuns.createdAt, cursor.createdAt), lt(agentRuns.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(filter.limit + 1);
    return toPage(
      rows.map((r) => toRun(r.run, r.agentName, r.agentVersion)),
      filter.limit,
      (r) => r,
    );
  }

  async countActive(organizationId: string): Promise<number> {
    const [row] = await executor(this.db)
      .select({ n: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.organizationId, organizationId),
          inArray(agentRuns.status, [...ACTIVE_STATUSES]),
          eq(agentRuns.trigger, 'chat'),
        ),
      );
    return row?.n ?? 0;
  }

  async tokensUsedSince(organizationId: string, since: Date): Promise<number> {
    const [row] = await executor(this.db)
      .select({ total: sum(sql`${agentRuns.promptTokens} + ${agentRuns.completionTokens}`) })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.organizationId, organizationId),
          sql`${agentRuns.createdAt} >= ${since.toISOString()}`,
        ),
      );
    return Number(row?.total ?? 0);
  }

  async transition(
    id: string,
    from: readonly RunStatus[],
    to: RunStatus,
    patch: Partial<RunRecord>,
    now: Date,
  ): Promise<boolean> {
    const updated = await executor(this.db)
      .update(agentRuns)
      .set({ ...runColumns(patch), status: to, updatedAt: now })
      .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, [...from])))
      .returning({ id: agentRuns.id });
    return updated.length > 0;
  }

  async update(id: string, patch: Partial<RunRecord>, now: Date): Promise<void> {
    await executor(this.db)
      .update(agentRuns)
      .set({ ...runColumns(patch), updatedAt: now })
      .where(eq(agentRuns.id, id));
  }

  async addUsage(
    id: string,
    usage: { promptTokens: number; completionTokens: number },
  ): Promise<void> {
    if (usage.promptTokens === 0 && usage.completionTokens === 0) return;
    await executor(this.db)
      .update(agentRuns)
      .set({
        promptTokens: sql`${agentRuns.promptTokens} + ${Math.round(usage.promptTokens)}`,
        completionTokens: sql`${agentRuns.completionTokens} + ${Math.round(usage.completionTokens)}`,
      })
      .where(eq(agentRuns.id, id));
  }

  async findStale(params: { queuedBefore: Date; now: Date; limit: number }): Promise<RunRecord[]> {
    const rows = await this.select()
      .where(
        or(
          and(eq(agentRuns.status, 'queued'), lt(agentRuns.createdAt, params.queuedBefore)),
          and(eq(agentRuns.status, 'running'), lt(agentRuns.deadlineAt, params.now)),
        ),
      )
      .orderBy(asc(agentRuns.createdAt))
      .limit(params.limit);
    return rows.map((r) => toRun(r.run, r.agentName, r.agentVersion));
  }

  async latestForTrigger(trigger: RunTrigger, triggerRefId: string): Promise<RunRecord | null> {
    const [row] = await this.select()
      .where(and(eq(agentRuns.trigger, trigger), eq(agentRuns.triggerRefId, triggerRefId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    return row ? toRun(row.run, row.agentName, row.agentVersion) : null;
  }

  async activeForTrigger(
    trigger: RunTrigger,
    triggerRefIds: string[],
  ): Promise<Map<string, string>> {
    if (triggerRefIds.length === 0) return new Map();
    const rows = await executor(this.db)
      .select({ id: agentRuns.id, ref: agentRuns.triggerRefId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.trigger, trigger),
          inArray(agentRuns.triggerRefId, triggerRefIds),
          inArray(agentRuns.status, [...ACTIVE_STATUSES]),
        ),
      );
    return new Map(rows.filter((r) => r.ref).map((r) => [r.ref!, r.id]));
  }
}

// =======================================================================================
// Steps and tool calls
// =======================================================================================

export class DrizzleStepRepository implements StepRepository {
  constructor(private readonly db: Database) {}

  async nextSeq(runId: string): Promise<number> {
    const [row] = await executor(this.db)
      .select({ max: sql<number>`coalesce(max(${agentRunSteps.seq}), 0)` })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId));
    return Number(row?.max ?? 0) + 1;
  }

  async insert(step: StepRecord): Promise<void> {
    await executor(this.db).insert(agentRunSteps).values(step);
  }

  async finish(id: string, patch: Partial<StepRecord>): Promise<void> {
    const { id: _id, runId: _r, organizationId: _o, ...rest } = patch;
    await executor(this.db).update(agentRunSteps).set(rest).where(eq(agentRunSteps.id, id));
  }

  async list(runId: string): Promise<StepRecord[]> {
    const rows = await executor(this.db)
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId))
      .orderBy(asc(agentRunSteps.seq));
    return rows.map((r) => ({
      ...r,
      kind: r.kind as StepKind,
      status: r.status as StepStatus,
      detail: r.detail ?? {},
      error: (r.error as RunError | null) ?? null,
    }));
  }
}

type ToolCallRow = typeof toolCalls.$inferSelect;
const toToolCall = (row: ToolCallRow, approvalId: string | null = null): ToolCallRecord => ({
  ...row,
  status: row.status as ToolCallStatus,
  error: (row.error as RunError | null) ?? null,
  approvalId,
});

export class DrizzleToolCallRepository implements ToolCallRepository {
  constructor(private readonly db: Database) {}

  async findByKey(idempotencyKey: string): Promise<ToolCallRecord | null> {
    const [row] = await executor(this.db)
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, idempotencyKey))
      .limit(1);
    return row ? toToolCall(row) : null;
  }

  async findById(id: string): Promise<ToolCallRecord | null> {
    const [row] = await executor(this.db)
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.id, id))
      .limit(1);
    return row ? toToolCall(row) : null;
  }

  async insert(call: ToolCallRecord): Promise<void> {
    const { approvalId: _a, ...row } = call;
    await executor(this.db).insert(toolCalls).values(row);
  }

  async update(id: string, patch: Partial<ToolCallRecord>): Promise<void> {
    const { approvalId: _a, id: _id, runId: _r, ...rest } = patch;
    if (Object.keys(rest).length === 0) return;
    await executor(this.db).update(toolCalls).set(rest).where(eq(toolCalls.id, id));
  }

  async list(runId: string): Promise<ToolCallRecord[]> {
    const rows = await executor(this.db)
      .select({ call: toolCalls, approvalId: approvalRequests.id })
      .from(toolCalls)
      .leftJoin(approvalRequests, eq(approvalRequests.toolCallId, toolCalls.id))
      .where(eq(toolCalls.runId, runId))
      .orderBy(asc(toolCalls.createdAt));
    return rows.map((r) => toToolCall(r.call, r.approvalId));
  }
}

// =======================================================================================
// Approvals
// =======================================================================================

const requester = alias(users, 'requester');
const decider = alias(users, 'decider');

type ApprovalRow = {
  approval: typeof approvalRequests.$inferSelect;
  projectName: string;
  toolName: string | null;
  requestedByName: string | null;
  decidedByName: string | null;
};

const toApproval = (row: ApprovalRow): ApprovalRecord => ({
  ...row.approval,
  toolCallId: row.approval.toolCallId ?? '',
  riskLevel: row.approval.riskLevel as RiskLevel,
  status: row.approval.status as ApprovalStatus,
  approverRoles: row.approval.approverRoles ?? [],
  projectName: row.projectName,
  toolName: row.toolName ?? '',
  requestedByName: row.requestedByName,
  decidedByName: row.decidedByName,
});

export class DrizzleApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select({
        approval: approvalRequests,
        projectName: projects.name,
        toolName: toolCalls.toolName,
        requestedByName: requester.name,
        decidedByName: decider.name,
      })
      .from(approvalRequests)
      .innerJoin(projects, eq(projects.id, approvalRequests.projectId))
      .leftJoin(toolCalls, eq(toolCalls.id, approvalRequests.toolCallId))
      .leftJoin(requester, eq(requester.id, approvalRequests.requestedBy))
      .leftJoin(decider, eq(decider.id, approvalRequests.decidedBy));
  }

  async insert(approval: ApprovalRecord): Promise<void> {
    const {
      projectName: _p,
      toolName: _t,
      requestedByName: _r,
      decidedByName: _d,
      ...row
    } = approval;
    await executor(this.db)
      .insert(approvalRequests)
      .values({ ...row, subjectType: 'tool_call' });
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    const [row] = await this.select().where(eq(approvalRequests.id, id)).limit(1);
    return row ? toApproval(row) : null;
  }

  async findByToolCall(toolCallId: string): Promise<ApprovalRecord | null> {
    const [row] = await this.select().where(eq(approvalRequests.toolCallId, toolCallId)).limit(1);
    return row ? toApproval(row) : null;
  }

  async decide(
    id: string,
    decision: {
      status: 'approved' | 'rejected' | 'expired' | 'cancelled';
      by: string | null;
      comment: string | null;
    },
    now: Date,
  ): Promise<boolean> {
    const updated = await executor(this.db)
      .update(approvalRequests)
      .set({
        status: decision.status,
        decidedBy: decision.by,
        decidedAt: now,
        decisionComment: decision.comment,
      })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')))
      .returning({ id: approvalRequests.id });
    return updated.length > 0;
  }

  async list(filter: {
    organizationId: string;
    projectId?: string;
    status?: ApprovalStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<ApprovalRecord>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(approvalRequests.organizationId, filter.organizationId)];
    if (filter.projectId) conditions.push(eq(approvalRequests.projectId, filter.projectId));
    if (filter.status) conditions.push(eq(approvalRequests.status, filter.status));
    if (cursor) {
      conditions.push(
        or(
          lt(approvalRequests.requestedAt, cursor.createdAt),
          and(
            eq(approvalRequests.requestedAt, cursor.createdAt),
            lt(approvalRequests.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id))
      .limit(filter.limit + 1);
    const records = rows.map((r) => ({ ...toApproval(r), createdAt: r.approval.requestedAt }));
    const page = toPage(
      records,
      filter.limit,
      ({ createdAt: _c, ...rest }) => rest as ApprovalRecord,
    );
    return page;
  }

  async findExpiredPending(now: Date, limit: number): Promise<ApprovalRecord[]> {
    const rows = await this.select()
      .where(and(eq(approvalRequests.status, 'pending'), lt(approvalRequests.expiresAt, now)))
      .orderBy(asc(approvalRequests.expiresAt))
      .limit(limit);
    return rows.map(toApproval);
  }

  async pendingForRun(runId: string): Promise<ApprovalRecord[]> {
    const rows = await this.select().where(
      and(eq(approvalRequests.runId, runId), eq(approvalRequests.status, 'pending')),
    );
    return rows.map(toApproval);
  }
}
