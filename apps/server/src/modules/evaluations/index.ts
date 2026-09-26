/** Public API of the evaluations module: datasets, cases, evaluators and evaluation runs. */
export {
  EvaluationUseCases,
  toCaseDto,
  toDatasetDto,
  toEvalRunDto,
} from './application/evaluation-use-cases';
export type { AgentRunner, CaseRecord, DatasetRecord, EvalRunRecord } from './application/ports';
export {
  evaluateCase,
  isRegression,
  type CaseExpectations,
  type RunObservation,
} from './domain/evaluators';
export {
  DrizzleCaseRepository,
  DrizzleDatasetRepository,
  DrizzleEvalRunRepository,
  DrizzleResultRepository,
} from './infrastructure/drizzle-evaluation-repositories';
export { evaluationRoutes } from './presentation/http/evaluation-routes';
export { evaluationWorker } from './presentation/jobs/evaluation-jobs';
