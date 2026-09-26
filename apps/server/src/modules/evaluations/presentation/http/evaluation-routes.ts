import {
  CreateEvaluationCaseInput,
  CreateEvaluationDatasetInput,
  EvaluationCaseDto,
  EvaluationDatasetDetailDto,
  EvaluationDatasetDto,
  EvaluationRunDetailDto,
  EvaluationRunDto,
  EvaluationRunListQuery,
  Id,
  pageOf,
  StartEvaluationRunInput,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import {
  toCaseDto,
  toDatasetDto,
  toEvalRunDto,
  type EvaluationUseCases,
} from '../../application/evaluation-use-cases';

const ProjectParams = z.object({ projectId: Id });
const DatasetParams = z.object({ datasetId: Id });
const CaseParams = z.object({ caseId: Id });
const RunParams = z.object({ evaluationRunId: Id });

export function evaluationRoutes(deps: { evaluations: EvaluationUseCases }) {
  const { evaluations } = deps;
  const named = (request: Parameters<typeof requireActor>[0]) => ({
    ...requireActor(request),
    name: request.auth!.user.name,
  });

  return async (api: App) => {
    api.get(
      '/projects/:projectId/evaluation-datasets',
      {
        schema: {
          tags: ['evaluations'],
          params: ProjectParams,
          response: { 200: z.array(EvaluationDatasetDto) },
        },
      },
      async (request) => evaluations.listDatasets(requireActor(request), request.params.projectId),
    );

    api.post(
      '/projects/:projectId/evaluation-datasets',
      {
        schema: {
          tags: ['evaluations'],
          params: ProjectParams,
          body: CreateEvaluationDatasetInput,
          response: { 201: EvaluationDatasetDto },
        },
      },
      async (request, reply) => {
        const dataset = await evaluations.createDataset(
          named(request),
          request.params.projectId,
          request.body,
        );
        return reply.status(201).send(toDatasetDto(dataset, null));
      },
    );

    api.get(
      '/evaluation-datasets/:datasetId',
      {
        schema: {
          tags: ['evaluations'],
          params: DatasetParams,
          response: { 200: EvaluationDatasetDetailDto },
        },
      },
      async (request) => {
        const { dataset, cases } = await evaluations.getDataset(
          requireActor(request),
          request.params.datasetId,
        );
        return { ...dataset, cases };
      },
    );

    api.post(
      '/evaluation-datasets/:datasetId/cases',
      {
        schema: {
          tags: ['evaluations'],
          params: DatasetParams,
          body: CreateEvaluationCaseInput,
          response: { 201: EvaluationCaseDto },
        },
      },
      async (request, reply) =>
        reply
          .status(201)
          .send(
            toCaseDto(
              await evaluations.addCase(
                requireActor(request),
                request.params.datasetId,
                request.body,
              ),
            ),
          ),
    );

    api.delete(
      '/evaluation-cases/:caseId',
      { schema: { tags: ['evaluations'], params: CaseParams } },
      async (request, reply) => {
        await evaluations.deleteCase(requireActor(request), request.params.caseId);
        return reply.status(204).send();
      },
    );

    api.post(
      '/evaluation-datasets/:datasetId/runs',
      {
        schema: {
          tags: ['evaluations'],
          summary: 'Run every case against an agent (background job)',
          params: DatasetParams,
          body: StartEvaluationRunInput,
          response: { 202: EvaluationRunDto },
        },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request, reply) =>
        reply
          .status(202)
          .send(
            toEvalRunDto(
              await evaluations.startRun(named(request), request.params.datasetId, request.body),
            ),
          ),
    );

    api.get(
      '/projects/:projectId/evaluation-runs',
      {
        schema: {
          tags: ['evaluations'],
          params: ProjectParams,
          querystring: EvaluationRunListQuery,
          response: { 200: pageOf(EvaluationRunDto) },
        },
      },
      async (request) =>
        evaluations.listRuns(requireActor(request), request.params.projectId, {
          limit: request.query.limit,
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
          ...(request.query.datasetId ? { datasetId: request.query.datasetId } : {}),
        }),
    );

    api.get(
      '/evaluation-runs/:evaluationRunId',
      {
        schema: {
          tags: ['evaluations'],
          params: RunParams,
          response: { 200: EvaluationRunDetailDto },
        },
      },
      async (request) => evaluations.getRun(requireActor(request), request.params.evaluationRunId),
    );
  };
}
