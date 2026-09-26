import type {
  OrganizationOverviewDto,
  ProjectCardDto,
  ProjectOverviewDto,
  RecentRunDto,
  RunsPerDayDto,
} from '@agentforge/contracts';
import type { Actor } from '../../../shared-kernel/ports';
import type { AuditQueries } from '../../audit';
import type { OrganizationAccess } from '../../organizations';
import type { ProjectAccess } from '../../projects';

/**
 * Insights is the one module allowed to read other modules' tables (and it never writes).
 * Dashboards need cross-module aggregates; routing each through every module's public API
 * would mean a dozen queries per page. The cost: schema changes elsewhere can break these
 * queries, which is why insights has its own integration tests.
 */
export interface InsightsReadModel {
  projectCards(organizationId: string): Promise<ProjectCardDto[]>;
  memberCount(organizationId: string): Promise<number>;
  pendingApprovals(scope: { organizationId: string } | { projectId: string }): Promise<number>;
  projectStats(projectId: string): Promise<ProjectOverviewDto['stats']>;
  runsPerDay(projectId: string, days: number): Promise<RunsPerDayDto[]>;
  recentRuns(projectId: string, limit: number): Promise<RecentRunDto[]>;
  recentConversations(
    projectId: string,
    limit: number,
  ): Promise<ProjectOverviewDto['recentConversations']>;
}

export interface OverviewCache {
  remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T>;
}

export class InsightsQueries {
  constructor(
    private readonly deps: {
      readModel: InsightsReadModel;
      organizationAccess: OrganizationAccess;
      projectAccess: ProjectAccess;
      auditQueries: AuditQueries;
      cache: OverviewCache;
      clock: { now(): Date };
    },
  ) {}

  async organizationOverview(
    actor: Actor,
    organizationId: string,
  ): Promise<OrganizationOverviewDto> {
    const { organization, role } = await this.deps.organizationAccess.require(
      actor,
      organizationId,
      'org:read',
    );
    const { readModel, auditQueries } = this.deps;
    const [projects, memberCount, pendingApprovals, recentActivity] = await Promise.all([
      readModel.projectCards(organizationId),
      readModel.memberCount(organizationId),
      readModel.pendingApprovals({ organizationId }),
      auditQueries.recent(organizationId, 10),
    ]);
    return {
      organization: { id: organization.id, name: organization.name, slug: organization.slug, role },
      memberCount,
      pendingApprovals,
      projects,
      recentActivity,
    };
  }

  /**
   * Cached for 30 seconds per project: every dashboard load would otherwise run ~8 aggregate
   * queries. The page shows when the numbers were computed (cachedAt).
   */
  async projectOverview(actor: Actor, projectId: string): Promise<ProjectOverviewDto> {
    const { project, role } = await this.deps.projectAccess.require(
      actor,
      projectId,
      'project:read',
    );
    const body = await this.deps.cache.remember(`project-overview:${projectId}`, 30, async () => {
      const { readModel, auditQueries } = this.deps;
      const [stats, runsPerDay, recentRuns, recentConversations, recentActivity] =
        await Promise.all([
          readModel.projectStats(projectId),
          readModel.runsPerDay(projectId, 14),
          readModel.recentRuns(projectId, 6),
          readModel.recentConversations(projectId, 6),
          auditQueries.recent(project.organizationId, 8, projectId),
        ]);
      return {
        project: {
          id: project.id,
          organizationId: project.organizationId,
          name: project.name,
          slug: project.slug,
          description: project.description,
        },
        stats,
        runsPerDay,
        recentRuns,
        recentConversations,
        recentActivity,
        cachedAt: this.deps.clock.now().toISOString(),
      };
    });
    return { ...body, role };
  }
}
