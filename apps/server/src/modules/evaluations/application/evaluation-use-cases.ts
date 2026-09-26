import type {
  CreateEvaluationCaseInput,
  CreateEvaluationDatasetInput,
  EvaluationCaseDto,
  EvaluationDatasetDto,
  EvaluationResultDto,
  EvaluationRunDetailDto,
  EvaluationRunDto,
  Page,
} from '@agentforge/contracts';
import { conflict, notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import type { AuditLog } from '../../audit';
import type { ProjectAccess } from '../../projects';
import {
  evaluateCase,
  isRegression,
  type RunObservation,
  type Verdict,
} from '../domain/evaluators';
import type {
  AgentRunner,
  CaseRecord,
  CaseRepository,
  DatasetRecord,
  DatasetRepository,
  EvalRunRecord,
  EvalRunRepository,
  ResultRecord,
  ResultRepository,
} from './ports';

type NamedActor = Actor & { name?: string };

export const toCaseDto = (c: CaseRecord): EvaluationCaseDto => ({
  id: c.id,
  datasetId: c.datasetId,
  name: c.name,
  category: c.category,
  input: c.input,
  expectations: c.expectations as EvaluationCaseDto['expectations'],
  tags: c.tags,
  createdAt: c.createdAt.toISOString(),
});

export const toEvalRunDto = (r: EvalRunRecord): EvaluationRunDto => ({
  id: r.id,
  datasetId: r.datasetId,
  datasetName: r.datasetName,
  datasetRevision: r.datasetRevision,
  agentId: r.agentId,
  agentName: r.agentName,
  agentVersion: r.agentVersion,
  status: r.status,
  provider: r.provider,
  model: r.model,
  promptVersion: r.promptVersion,
  gitSha: r.gitSha,
  totalCases: r.totalCases,
  passed: r.passed,
  failed: r.failed,
  errored: r.errored,
  passRate: r.totalCases > 0 && r.status === 'completed' ? r.passed / r.totalCases : null,
  regressions: r.regressions,
  baselineRunId: r.baselineRunId,
  triggeredBy: r.triggeredBy ? { id: r.triggeredBy, name: r.triggeredByName ?? 'Unknown' } : null,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  completedAt: r.completedAt?.toISOString() ?? null,
});

export const toDatasetDto = (
  d: DatasetRecord,
  lastRun: EvalRunRecord | null,
): EvaluationDatasetDto => ({
  id: d.id,
  projectId: d.projectId,
  name: d.name,
  description: d.description,
  revision: d.revision,
  caseCount: d.caseCount,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  lastRun: lastRun ? toEvalRunDto(lastRun) : null,
});

export interface EvaluationDeps {
  datasets: DatasetRepository;
  cases: CaseRepository;
  runs: EvalRunRepository;
  results: ResultRepository;
  runner: AgentRunner;
  projectAccess: ProjectAccess;
  jobs: BackgroundJobs;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
  promptVersion: string;
  gitSha: string | null;
}

export class EvaluationUseCases {
  constructor(private readonly deps: EvaluationDeps) {}

  // ---- datasets and cases --------------------------------------------------------------

  async listDatasets(actor: Actor, projectId: string): Promise<EvaluationDatasetDto[]> {
    await this.deps.projectAccess.require(actor, projectId, 'evaluation:read');
    const [datasets, lastRuns] = await Promise.all([
      this.deps.datasets.list(projectId),
      this.deps.runs.lastRunPerDataset(projectId),
    ]);
    return datasets.map((d) => toDatasetDto(d, lastRuns.get(d.id) ?? null));
  }

  async createDataset(
    actor: NamedActor,
    projectId: string,
    input: CreateEvaluationDatasetInput,
  ): Promise<DatasetRecord> {
    const { project } = await this.deps.projectAccess.require(
      actor,
      projectId,
      'evaluation:manage',
    );
    if (await this.deps.datasets.findByName(projectId, input.name))
      throw conflict('DATASET_NAME_TAKEN', 'A dataset with this name already exists');
    const now = this.deps.clock.now();
    const record = {
      id: newId(now.getTime()),
      organizationId: project.organizationId,
      projectId,
      name: input.name,
      description: input.description,
      revision: 1,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.datasets.insert(record);
    return { ...record, caseCount: 0 };
  }

  async getDataset(
    actor: Actor,
    datasetId: string,
  ): Promise<{ dataset: EvaluationDatasetDto; cases: EvaluationCaseDto[] }> {
    const dataset = await this.loadDataset(actor, datasetId, 'evaluation:read');
    const [cases, lastRuns] = await Promise.all([
      this.deps.cases.list(datasetId),
      this.deps.runs.lastRunPerDataset(dataset.projectId),
    ]);
    return {
      dataset: toDatasetDto(dataset, lastRuns.get(dataset.id) ?? null),
      cases: cases.map(toCaseDto),
    };
  }

  async addCase(
    actor: Actor,
    datasetId: string,
    input: CreateEvaluationCaseInput,
  ): Promise<CaseRecord> {
    const dataset = await this.loadDataset(actor, datasetId, 'evaluation:manage');
    if (await this.deps.cases.nameExists(datasetId, input.name))
      throw conflict('CASE_NAME_TAKEN', 'A case with this name already exists');
    return this.deps.tx.run(async () => {
      const now = this.deps.clock.now();
      const record: CaseRecord = {
        id: newId(now.getTime()),
        datasetId,
        organizationId: dataset.organizationId,
        projectId: dataset.projectId,
        name: input.name,
        category: input.category,
        input: input.input,
        expectations: input.expectations,
        tags: input.tags,
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.cases.insert(record);
      await this.deps.datasets.bumpRevision(datasetId, now);
      return record;
    });
  }

  async deleteCase(actor: Actor, caseId: string): Promise<void> {
    const record = await this.deps.cases.findById(caseId);
    if (!record) throw notFound('CASE_NOT_FOUND', 'Case not found');
    await this.deps.projectAccess.require(actor, record.projectId, 'evaluation:manage');
    await this.deps.tx.run(async () => {
      await this.deps.cases.delete(caseId);
      await this.deps.datasets.bumpRevision(record.datasetId, this.deps.clock.now());
    });
  }

  // ---- runs ----------------------------------------------------------------------------

  async startRun(
    actor: NamedActor,
    datasetId: string,
    input: { agentId: string; baselineRunId?: string | undefined },
  ): Promise<EvalRunRecord> {
    const dataset = await this.loadDataset(actor, datasetId, 'evaluation:run');
    const agent = await this.deps.runner.describeAgent(input.agentId);
    if (!agent || agent.projectId !== dataset.projectId)
      throw notFound('AGENT_NOT_FOUND', 'Agent not found in this project');
    if (dataset.caseCount === 0)
      throw conflict('DATASET_EMPTY', 'Add at least one case before running an evaluation');
    const now = this.deps.clock.now();
    const id = newId(now.getTime());
    await this.deps.tx.run(async () => {
      await this.deps.runs.insert({
        id,
        organizationId: dataset.organizationId,
        projectId: dataset.projectId,
        datasetId,
        datasetRevision: dataset.revision,
        agentId: agent.id,
        agentVersionId: agent.versionId,
        status: 'queued',
        provider: agent.provider,
        model: agent.model,
        promptVersion: this.deps.promptVersion,
        gitSha: this.deps.gitSha,
        totalCases: dataset.caseCount,
        passed: 0,
        failed: 0,
        errored: 0,
        regressions: 0,
        baselineRunId: input.baselineRunId ?? null,
        triggeredBy: actor.userId,
        error: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      });
      await this.deps.audit.record({
        organizationId: dataset.organizationId,
        projectId: dataset.projectId,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: 'evaluation.started',
        target: { type: 'evaluation_run', id },
        metadata: { dataset: dataset.name, agent: agent.name, agentVersion: agent.version },
      });
      await this.deps.jobs.enqueue(
        'evaluation.run',
        { evaluationRunId: id },
        { dedupeKey: `eval-${id}` },
      );
    });
    return (await this.deps.runs.findById(id))!;
  }

  async listRuns(
    actor: Actor,
    projectId: string,
    filter: { datasetId?: string; limit: number; cursor?: string },
  ): Promise<Page<EvaluationRunDto>> {
    await this.deps.projectAccess.require(actor, projectId, 'evaluation:read');
    const page = await this.deps.runs.list({ projectId, ...filter });
    return { data: page.data.map(toEvalRunDto), page: page.page };
  }

  async getRun(actor: Actor, evaluationRunId: string): Promise<EvaluationRunDetailDto> {
    const run = await this.deps.runs.findById(evaluationRunId);
    if (!run) throw notFound('EVALUATION_RUN_NOT_FOUND', 'Evaluation run not found');
    await this.deps.projectAccess.require(actor, run.projectId, 'evaluation:read');
    const results = await this.deps.results.list(run.id);
    const baseline = run.baselineRunId
      ? new Map((await this.deps.results.list(run.baselineRunId)).map((r) => [r.caseId, r.verdict]))
      : new Map<string, Verdict>();
    return {
      ...toEvalRunDto(run),
      results: results.map((r): EvaluationResultDto => ({
        id: r.id,
        caseId: r.caseId,
        caseName: r.caseName,
        category: r.category,
        input: r.input,
        verdict: r.verdict,
        score: r.score,
        evaluatorResults: r.evaluatorResults,
        agentRunId: r.agentRunId,
        output: r.output,
        toolsCalled: r.toolsCalled,
        durationMs: r.durationMs,
        baselineVerdict: baseline.get(r.caseId) ?? null,
        regression: isRegression(r.verdict, baseline.get(r.caseId) ?? null),
      })),
    };
  }

  /**
   * The evaluation job: runs every case against the pinned agent version, sequentially (cases
   * share the project's rate limits), scores each, then compares with the baseline run
   * (explicit, or the previous completed run of the same dataset).
   */
  async execute(evaluationRunId: string): Promise<void> {
    const { runs, cases, results, runner, clock, audit } = this.deps;
    const run = await runs.findById(evaluationRunId);
    if (!run || run.status === 'completed' || run.status === 'failed') return;
    if (!(await runs.claim(run.id, clock.now()))) return;
    try {
      const baselineId =
        run.baselineRunId ?? (await runs.latestCompleted(run.datasetId, run.id))?.id ?? null;
      const baseline = baselineId
        ? new Map((await results.list(baselineId)).map((r) => [r.caseId, r.verdict]))
        : new Map<string, Verdict>();
      const done = new Map((await results.list(run.id)).map((r) => [r.caseId, r]));
      const caseList = await cases.list(run.datasetId);
      const actor = {
        userId: run.triggeredBy ?? '',
        sessionId: null,
        ...(run.triggeredByName ? { name: run.triggeredByName } : {}),
      };
      const tally = { passed: 0, failed: 0, errored: 0, regressions: 0 };

      for (const testCase of caseList) {
        let verdict: Verdict;
        const previous = done.get(testCase.id);
        if (previous) {
          verdict = previous.verdict;
        } else {
          let observation: RunObservation;
          try {
            observation = await runner.run({
              actor,
              projectId: run.projectId,
              agentId: run.agentId,
              evaluationRunId: run.id,
              input: testCase.input,
            });
          } catch (error) {
            observation = {
              runId: '',
              status: 'failed',
              text: '',
              citedDocuments: [],
              toolsCalled: [],
              approvalRequested: false,
              refused: false,
              structuredValid: null,
              durationMs: null,
              errorCode: (error as { code?: string }).code ?? 'EVALUATION_ERROR',
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          }
          const outcome = evaluateCase(testCase.expectations, observation);
          verdict = outcome.verdict;
          await results.upsert({
            id: newId(clock.now().getTime()),
            evaluationRunId: run.id,
            caseId: testCase.id,
            organizationId: run.organizationId,
            agentRunId: observation.runId || null,
            verdict,
            score: outcome.score,
            evaluatorResults: outcome.results,
            output: observation.text.slice(0, 4_000),
            toolsCalled: observation.toolsCalled,
            durationMs: observation.durationMs,
            createdAt: clock.now(),
          });
        }
        if (verdict === 'passed') tally.passed += 1;
        else if (verdict === 'failed') tally.failed += 1;
        else tally.errored += 1;
        if (isRegression(verdict, baseline.get(testCase.id) ?? null)) tally.regressions += 1;
        await runs.update(run.id, { ...tally });
      }

      const completedAt = clock.now();
      await runs.update(run.id, {
        status: 'completed',
        completedAt,
        totalCases: caseList.length,
        baselineRunId: baselineId,
        ...tally,
      });
      await audit.record({
        organizationId: run.organizationId,
        projectId: run.projectId,
        actor: { type: 'system', name: 'Evaluation runner' },
        action: 'evaluation.completed',
        target: { type: 'evaluation_run', id: run.id },
        metadata: { passed: tally.passed, total: caseList.length, regressions: tally.regressions },
      });
    } catch (error) {
      await runs.update(run.id, {
        status: 'failed',
        completedAt: clock.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async loadDataset(
    actor: Actor,
    datasetId: string,
    permission: 'evaluation:read' | 'evaluation:manage' | 'evaluation:run',
  ): Promise<DatasetRecord> {
    const dataset = await this.deps.datasets.findById(datasetId);
    if (!dataset) throw notFound('DATASET_NOT_FOUND', 'Dataset not found');
    await this.deps.projectAccess.require(actor, dataset.projectId, permission);
    return dataset;
  }
}

export type { ResultRecord };
