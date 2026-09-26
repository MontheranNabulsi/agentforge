import type { Page, ProjectDto } from '@agentforge/contracts';
import { conflict, notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { slugify } from '../../../shared-kernel/text';
import type { AuditLog } from '../../audit';
import type { OrganizationAccess, Permission, Role } from '../../organizations';

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ProjectListFilter {
  organizationId: string;
  limit: number;
  cursor?: string;
  slug?: string;
  includeArchived: boolean;
}

export interface ProjectRepository {
  create(project: Project): Promise<void>;
  findById(id: string): Promise<Project | null>;
  slugExists(organizationId: string, slug: string): Promise<boolean>;
  update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'archivedAt'>>,
    now: Date,
  ): Promise<Project>;
  list(filter: ProjectListFilter): Promise<Page<Project>>;
}

export interface ProjectAccessGrant {
  project: Project;
  role: Role;
}

export const toProjectDto = (project: Project): ProjectDto => ({
  id: project.id,
  organizationId: project.organizationId,
  name: project.name,
  slug: project.slug,
  description: project.description,
  archivedAt: project.archivedAt?.toISOString() ?? null,
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
});

/**
 * Project-scoped authorization. Resolves the project, then checks the actor's role in the
 * project's organization. Every module that owns project data (knowledge, agents,
 * conversations, evaluations) starts its use cases with ProjectAccess.require().
 */
export class ProjectAccess {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly organizations: OrganizationAccess,
  ) {}

  async require(
    actor: Actor,
    projectId: string,
    permission: Permission,
  ): Promise<ProjectAccessGrant> {
    const project = await this.projects.findById(projectId);
    if (!project) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
    try {
      const { role } = await this.organizations.require(actor, project.organizationId, permission);
      return { project, role };
    } catch (error) {
      // Outsiders get the same answer as for a project that does not exist.
      if (
        error instanceof Error &&
        (error as { code?: string }).code === 'ORGANIZATION_NOT_FOUND'
      ) {
        throw notFound('PROJECT_NOT_FOUND', 'Project not found');
      }
      throw error;
    }
  }

  /** For background work that already knows the project exists (no actor). */
  async load(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (!project) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }
}

export interface ProjectDeps {
  projects: ProjectRepository;
  organizationAccess: OrganizationAccess;
  projectAccess: ProjectAccess;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
  /** Called inside the create transaction (e.g. agents module adds a default agent). */
  onProjectCreated: ((project: Project, actor: Actor) => Promise<void>)[];
}

type NamedActor = Actor & { name?: string };
const userActor = (actor: NamedActor) => ({
  type: 'user' as const,
  id: actor.userId,
  ...(actor.name ? { name: actor.name } : {}),
});

export class ProjectUseCases {
  constructor(private readonly deps: ProjectDeps) {}

  async create(
    actor: NamedActor,
    organizationId: string,
    input: { name: string; slug?: string; description?: string },
  ): Promise<Project> {
    const { projects, organizationAccess, audit, tx, clock, onProjectCreated } = this.deps;
    await organizationAccess.require(actor, organizationId, 'project:create');
    return tx.run(async () => {
      const now = clock.now();
      const slug = input.slug ?? (await this.availableSlug(organizationId, input.name));
      if (input.slug && (await projects.slugExists(organizationId, input.slug))) {
        throw conflict('PROJECT_SLUG_TAKEN', 'A project with this URL already exists');
      }
      const project: Project = {
        id: newId(now.getTime()),
        organizationId,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? '',
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      await projects.create(project);
      await audit.record({
        organizationId,
        projectId: project.id,
        actor: userActor(actor),
        action: 'project.created',
        target: { type: 'project', id: project.id },
        metadata: { name: project.name },
      });
      for (const hook of onProjectCreated) await hook(project, actor);
      return project;
    });
  }

  async list(actor: Actor, filter: ProjectListFilter): Promise<Page<Project>> {
    await this.deps.organizationAccess.require(actor, filter.organizationId, 'project:read');
    return this.deps.projects.list(filter);
  }

  async get(actor: Actor, projectId: string): Promise<ProjectAccessGrant> {
    return this.deps.projectAccess.require(actor, projectId, 'project:read');
  }

  async update(
    actor: NamedActor,
    projectId: string,
    patch: { name?: string; description?: string },
  ): Promise<Project> {
    const { projects, projectAccess, audit, tx, clock } = this.deps;
    return tx.run(async () => {
      const { project } = await projectAccess.require(actor, projectId, 'project:update');
      const updated = await projects.update(
        projectId,
        {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        },
        clock.now(),
      );
      await audit.record({
        organizationId: project.organizationId,
        projectId,
        actor: userActor(actor),
        action: 'project.updated',
        target: { type: 'project', id: projectId },
        metadata: { fields: Object.keys(patch) },
      });
      return updated;
    });
  }

  async setArchived(actor: NamedActor, projectId: string, archived: boolean): Promise<Project> {
    const { projects, projectAccess, audit, tx, clock } = this.deps;
    return tx.run(async () => {
      const { project } = await projectAccess.require(actor, projectId, 'project:archive');
      const now = clock.now();
      const updated = await projects.update(projectId, { archivedAt: archived ? now : null }, now);
      await audit.record({
        organizationId: project.organizationId,
        projectId,
        actor: userActor(actor),
        action: archived ? 'project.archived' : 'project.restored',
        target: { type: 'project', id: projectId },
      });
      return updated;
    });
  }

  private async availableSlug(organizationId: string, name: string): Promise<string> {
    const base = slugify(name, 40) || 'project';
    if (!(await this.deps.projects.slugExists(organizationId, base))) return base;
    for (let i = 2; i < 50; i += 1) {
      const candidate = `${base}-${i}`;
      if (!(await this.deps.projects.slugExists(organizationId, candidate))) return candidate;
    }
    return `${base}-${newId().slice(-6)}`;
  }
}
