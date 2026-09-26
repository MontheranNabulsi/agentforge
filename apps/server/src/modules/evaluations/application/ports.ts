import type { EvalCategory, Page } from '@agentforge/contracts';
import type { Actor } from '../../../shared-kernel/ports';
import type {
  CaseExpectations,
  EvaluatorResult,
  RunObservation,
  Verdict,
} from '../domain/evaluators';

export interface DatasetRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  description: string;
  revision: number;
  caseCount: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseRecord {
  id: string;
  datasetId: string;
  organizationId: string;
  projectId: string;
  name: string;
  category: EvalCategory;
  input: string;
  expectations: CaseExpectations;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type EvalRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface EvalRunRecord {
  id: string;
  organizationId: string;
  projectId: string;
  datasetId: string;
  datasetName: string;
  datasetRevision: number;
  agentId: string;
  agentName: string;
  agentVersionId: string;
  agentVersion: number;
  status: EvalRunStatus;
  provider: string;
  model: string;
  promptVersion: string;
  gitSha: string | null;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  regressions: number;
  baselineRunId: string | null;
  triggeredBy: string | null;
  triggeredByName: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ResultRecord {
  id: string;
  evaluationRunId: string;
  caseId: string;
  caseName: string;
  category: EvalCategory;
  input: string;
  organizationId: string;
  agentRunId: string | null;
  verdict: Verdict;
  score: number;
  evaluatorResults: EvaluatorResult[];
  output: string;
  toolsCalled: string[];
  durationMs: number | null;
  createdAt: Date;
}

export interface DatasetRepository {
  insert(dataset: Omit<DatasetRecord, 'caseCount'>): Promise<void>;
  findById(id: string): Promise<DatasetRecord | null>;
  findByName(projectId: string, name: string): Promise<DatasetRecord | null>;
  list(projectId: string): Promise<DatasetRecord[]>;
  bumpRevision(id: string, now: Date): Promise<void>;
}

export interface CaseRepository {
  insert(record: CaseRecord): Promise<void>;
  findById(id: string): Promise<CaseRecord | null>;
  list(datasetId: string): Promise<CaseRecord[]>;
  delete(id: string): Promise<void>;
  nameExists(datasetId: string, name: string): Promise<boolean>;
}

export interface EvalRunRepository {
  insert(
    run: Omit<EvalRunRecord, 'datasetName' | 'agentName' | 'agentVersion' | 'triggeredByName'>,
  ): Promise<void>;
  findById(id: string): Promise<EvalRunRecord | null>;
  list(filter: {
    projectId: string;
    datasetId?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<EvalRunRecord>>;
  update(id: string, patch: Partial<EvalRunRecord>): Promise<void>;
  /** Conditional: queued → running, so a retried job does not run the suite twice in parallel. */
  claim(id: string, now: Date): Promise<boolean>;
  latestCompleted(datasetId: string, excludeId: string): Promise<EvalRunRecord | null>;
  lastRunPerDataset(projectId: string): Promise<Map<string, EvalRunRecord>>;
}

export interface ResultRepository {
  upsert(result: Omit<ResultRecord, 'caseName' | 'category' | 'input'>): Promise<void>;
  list(evaluationRunId: string): Promise<ResultRecord[]>;
}

/** How evaluations run an agent: implemented with the agents module by the composition root. */
export interface AgentRunner {
  describeAgent(agentId: string): Promise<{
    id: string;
    name: string;
    projectId: string;
    versionId: string;
    version: number;
    model: string;
    provider: string;
  } | null>;
  run(params: {
    actor: Actor & { name?: string };
    projectId: string;
    agentId: string;
    evaluationRunId: string;
    input: string;
  }): Promise<RunObservation>;
}
