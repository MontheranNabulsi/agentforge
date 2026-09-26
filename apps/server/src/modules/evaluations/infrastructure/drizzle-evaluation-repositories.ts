import type { EvalCategory, Page } from '@agentforge/contracts';
import { and, asc, count, desc, eq, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  agents,
  agentVersions,
  evaluationCases,
  evaluationDatasets,
  evaluationResults,
  evaluationRuns,
  users,
} from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { executor } from '../../../platform/database/transaction';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type { CaseExpectations, EvaluatorResult, Verdict } from '../domain/evaluators';
import type {
  CaseRecord,
  CaseRepository,
  DatasetRecord,
  DatasetRepository,
  EvalRunRecord,
  EvalRunRepository,
  EvalRunStatus,
  ResultRecord,
  ResultRepository,
} from '../application/ports';

export class DrizzleDatasetRepository implements DatasetRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select({
        dataset: evaluationDatasets,
        // Written as literal SQL: drizzle leaves columns unqualified in single-table selects,
        // which would make this correlated subquery compare c.dataset_id with c.id.
        caseCount: sql<number>`(SELECT count(*)::int FROM evaluation_cases c WHERE c.dataset_id = "evaluation_datasets"."id")`,
      })
      .from(evaluationDatasets);
  }

  async insert(dataset: Omit<DatasetRecord, 'caseCount'>): Promise<void> {
    await executor(this.db).insert(evaluationDatasets).values(dataset);
  }

  async findById(id: string): Promise<DatasetRecord | null> {
    const [row] = await this.select().where(eq(evaluationDatasets.id, id)).limit(1);
    return row ? { ...row.dataset, caseCount: Number(row.caseCount) } : null;
  }

  async findByName(projectId: string, name: string): Promise<DatasetRecord | null> {
    const [row] = await this.select()
      .where(and(eq(evaluationDatasets.projectId, projectId), eq(evaluationDatasets.name, name)))
      .limit(1);
    return row ? { ...row.dataset, caseCount: Number(row.caseCount) } : null;
  }

  async list(projectId: string): Promise<DatasetRecord[]> {
    const rows = await this.select()
      .where(eq(evaluationDatasets.projectId, projectId))
      .orderBy(asc(evaluationDatasets.createdAt));
    return rows.map((row) => ({ ...row.dataset, caseCount: Number(row.caseCount) }));
  }

  async bumpRevision(id: string, now: Date): Promise<void> {
    await executor(this.db)
      .update(evaluationDatasets)
      .set({ revision: sql`${evaluationDatasets.revision} + 1`, updatedAt: now })
      .where(eq(evaluationDatasets.id, id));
  }
}

const toCase = (row: typeof evaluationCases.$inferSelect): CaseRecord => ({
  ...row,
  category: row.category as EvalCategory,
  expectations: row.expectations as CaseExpectations,
  tags: row.tags ?? [],
});

export class DrizzleCaseRepository implements CaseRepository {
  constructor(private readonly db: Database) {}

  async insert(record: CaseRecord): Promise<void> {
    await executor(this.db)
      .insert(evaluationCases)
      .values({ ...record, expectations: record.expectations as Record<string, unknown> });
  }

  async findById(id: string): Promise<CaseRecord | null> {
    const [row] = await executor(this.db)
      .select()
      .from(evaluationCases)
      .where(eq(evaluationCases.id, id))
      .limit(1);
    return row ? toCase(row) : null;
  }

  async list(datasetId: string): Promise<CaseRecord[]> {
    const rows = await executor(this.db)
      .select()
      .from(evaluationCases)
      .where(eq(evaluationCases.datasetId, datasetId))
      .orderBy(asc(evaluationCases.createdAt), asc(evaluationCases.id));
    return rows.map(toCase);
  }

  async delete(id: string): Promise<void> {
    await executor(this.db).delete(evaluationCases).where(eq(evaluationCases.id, id));
  }

  async nameExists(datasetId: string, name: string): Promise<boolean> {
    const [row] = await executor(this.db)
      .select({ n: count() })
      .from(evaluationCases)
      .where(and(eq(evaluationCases.datasetId, datasetId), eq(evaluationCases.name, name)));
    return (row?.n ?? 0) > 0;
  }
}

export class DrizzleEvalRunRepository implements EvalRunRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select({
        run: evaluationRuns,
        datasetName: evaluationDatasets.name,
        agentName: agents.name,
        agentVersion: agentVersions.version,
        triggeredByName: users.name,
      })
      .from(evaluationRuns)
      .innerJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationRuns.datasetId))
      .innerJoin(agents, eq(agents.id, evaluationRuns.agentId))
      .innerJoin(agentVersions, eq(agentVersions.id, evaluationRuns.agentVersionId))
      .leftJoin(users, eq(users.id, evaluationRuns.triggeredBy));
  }

  private toRecord(row: {
    run: typeof evaluationRuns.$inferSelect;
    datasetName: string;
    agentName: string;
    agentVersion: number;
    triggeredByName: string | null;
  }): EvalRunRecord {
    return {
      ...row.run,
      status: row.run.status as EvalRunStatus,
      datasetName: row.datasetName,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      triggeredByName: row.triggeredByName,
    };
  }

  async insert(
    run: Omit<EvalRunRecord, 'datasetName' | 'agentName' | 'agentVersion' | 'triggeredByName'>,
  ): Promise<void> {
    await executor(this.db).insert(evaluationRuns).values(run);
  }

  async findById(id: string): Promise<EvalRunRecord | null> {
    const [row] = await this.select().where(eq(evaluationRuns.id, id)).limit(1);
    return row ? this.toRecord(row) : null;
  }

  async list(filter: {
    projectId: string;
    datasetId?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<EvalRunRecord>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(evaluationRuns.projectId, filter.projectId)];
    if (filter.datasetId) conditions.push(eq(evaluationRuns.datasetId, filter.datasetId));
    if (cursor) {
      conditions.push(
        or(
          lt(evaluationRuns.createdAt, cursor.createdAt),
          and(eq(evaluationRuns.createdAt, cursor.createdAt), lt(evaluationRuns.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(evaluationRuns.createdAt), desc(evaluationRuns.id))
      .limit(filter.limit + 1);
    return toPage(
      rows.map((r) => this.toRecord(r)),
      filter.limit,
      (r) => r,
    );
  }

  async update(id: string, patch: Partial<EvalRunRecord>): Promise<void> {
    const {
      datasetName: _d,
      agentName: _a,
      agentVersion: _v,
      triggeredByName: _t,
      id: _id,
      ...rest
    } = patch;
    if (Object.keys(rest).length === 0) return;
    await executor(this.db).update(evaluationRuns).set(rest).where(eq(evaluationRuns.id, id));
  }

  async claim(id: string, now: Date): Promise<boolean> {
    const updated = await executor(this.db)
      .update(evaluationRuns)
      .set({ status: 'running', startedAt: now })
      // A running evaluation is only taken over when it stalled (its worker died mid-run).
      .where(
        and(
          eq(evaluationRuns.id, id),
          or(
            eq(evaluationRuns.status, 'queued'),
            and(
              eq(evaluationRuns.status, 'running'),
              lt(evaluationRuns.startedAt, new Date(now.getTime() - 15 * 60_000)),
            ),
          ),
        ),
      )
      .returning({ id: evaluationRuns.id });
    return updated.length > 0;
  }

  async latestCompleted(datasetId: string, excludeId: string): Promise<EvalRunRecord | null> {
    const [row] = await this.select()
      .where(
        and(
          eq(evaluationRuns.datasetId, datasetId),
          eq(evaluationRuns.status, 'completed'),
          ne(evaluationRuns.id, excludeId),
        ),
      )
      .orderBy(desc(evaluationRuns.completedAt))
      .limit(1);
    return row ? this.toRecord(row) : null;
  }

  async lastRunPerDataset(projectId: string): Promise<Map<string, EvalRunRecord>> {
    const rows = await this.select()
      .where(eq(evaluationRuns.projectId, projectId))
      .orderBy(desc(evaluationRuns.createdAt))
      .limit(200);
    const map = new Map<string, EvalRunRecord>();
    for (const row of rows)
      if (!map.has(row.run.datasetId)) map.set(row.run.datasetId, this.toRecord(row));
    return map;
  }
}

export class DrizzleResultRepository implements ResultRepository {
  constructor(private readonly db: Database) {}

  async upsert(result: Omit<ResultRecord, 'caseName' | 'category' | 'input'>): Promise<void> {
    await executor(this.db)
      .insert(evaluationResults)
      .values({ ...result, evaluatorResults: result.evaluatorResults as unknown[] })
      .onConflictDoUpdate({
        target: [evaluationResults.evaluationRunId, evaluationResults.caseId],
        set: {
          verdict: result.verdict,
          score: result.score,
          evaluatorResults: result.evaluatorResults as unknown[],
          output: result.output,
          toolsCalled: result.toolsCalled,
          durationMs: result.durationMs,
          agentRunId: result.agentRunId,
        },
      });
  }

  async list(evaluationRunId: string): Promise<ResultRecord[]> {
    const rows = await executor(this.db)
      .select({
        result: evaluationResults,
        caseName: evaluationCases.name,
        category: evaluationCases.category,
        input: evaluationCases.input,
      })
      .from(evaluationResults)
      .innerJoin(evaluationCases, eq(evaluationCases.id, evaluationResults.caseId))
      .where(eq(evaluationResults.evaluationRunId, evaluationRunId))
      .orderBy(asc(evaluationCases.createdAt), asc(evaluationCases.id));
    return rows.map((r) => ({
      ...r.result,
      verdict: r.result.verdict as Verdict,
      evaluatorResults: (r.result.evaluatorResults ?? []) as EvaluatorResult[],
      toolsCalled: r.result.toolsCalled ?? [],
      caseName: r.caseName,
      category: r.category as EvalCategory,
      input: r.input,
    }));
  }
}
