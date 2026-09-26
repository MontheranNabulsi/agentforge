import {
  Id,
  OrganizationOverviewDto,
  ProjectOverviewDto,
  SystemStatusDto,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import type { InsightsQueries } from '../../application/insights-queries';

export function insightsRoutes(deps: {
  insights: InsightsQueries;
  systemStatus: () => Promise<z.infer<typeof SystemStatusDto>>;
}) {
  return async (api: App) => {
    api.get(
      '/orgs/:orgId/overview',
      {
        schema: {
          tags: ['insights'],
          summary: 'Organization dashboard',
          params: z.object({ orgId: Id }),
          response: { 200: OrganizationOverviewDto },
        },
      },
      async (request) =>
        deps.insights.organizationOverview(requireActor(request), request.params.orgId),
    );

    api.get(
      '/projects/:projectId/overview',
      {
        schema: {
          tags: ['insights'],
          summary: 'Project dashboard (cached for 30 seconds)',
          params: z.object({ projectId: Id }),
          response: { 200: ProjectOverviewDto },
        },
      },
      async (request) =>
        deps.insights.projectOverview(requireActor(request), request.params.projectId),
    );

    api.get(
      '/system/status',
      {
        schema: {
          tags: ['insights'],
          summary: 'Health of the platform behind this workspace',
          response: { 200: SystemStatusDto },
        },
      },
      async (request) => {
        requireActor(request);
        return deps.systemStatus();
      },
    );
  };
}
