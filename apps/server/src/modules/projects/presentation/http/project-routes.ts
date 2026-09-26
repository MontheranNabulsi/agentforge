import {
  CreateProjectInput,
  Id,
  pageOf,
  ProjectDto,
  ProjectListQuery,
  UpdateProjectInput,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import { toProjectDto, type ProjectUseCases } from '../../application/project-use-cases';

const OrgParams = z.object({ orgId: Id });
const ProjectParams = z.object({ projectId: Id });

export function projectRoutes(deps: { projects: ProjectUseCases }) {
  const { projects } = deps;
  const named = (request: Parameters<typeof requireActor>[0]) => ({
    ...requireActor(request),
    name: request.auth!.user.name,
  });

  return async (api: App) => {
    api.get(
      '/orgs/:orgId/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'List projects (filter by slug to resolve a URL)',
          params: OrgParams,
          querystring: ProjectListQuery,
          response: { 200: pageOf(ProjectDto) },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await projects.list(requireActor(request), {
          organizationId: request.params.orgId,
          limit: q.limit,
          includeArchived: q.includeArchived,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.slug ? { slug: q.slug } : {}),
        });
        return { data: page.data.map(toProjectDto), page: page.page };
      },
    );

    api.post(
      '/orgs/:orgId/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'Create a project (also creates its default agent)',
          params: OrgParams,
          body: CreateProjectInput,
          response: { 201: ProjectDto },
        },
      },
      async (request, reply) => {
        const project = await projects.create(named(request), request.params.orgId, request.body);
        return reply.status(201).send(toProjectDto(project));
      },
    );

    api.get(
      '/projects/:projectId',
      { schema: { tags: ['projects'], params: ProjectParams, response: { 200: ProjectDto } } },
      async (request) =>
        toProjectDto((await projects.get(requireActor(request), request.params.projectId)).project),
    );

    api.patch(
      '/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          params: ProjectParams,
          body: UpdateProjectInput,
          response: { 200: ProjectDto },
        },
      },
      async (request) =>
        toProjectDto(await projects.update(named(request), request.params.projectId, request.body)),
    );

    api.post(
      '/projects/:projectId/archive',
      { schema: { tags: ['projects'], params: ProjectParams, response: { 200: ProjectDto } } },
      async (request) =>
        toProjectDto(await projects.setArchived(named(request), request.params.projectId, true)),
    );

    api.post(
      '/projects/:projectId/restore',
      { schema: { tags: ['projects'], params: ProjectParams, response: { 200: ProjectDto } } },
      async (request) =>
        toProjectDto(await projects.setArchived(named(request), request.params.projectId, false)),
    );
  };
}
