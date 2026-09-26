import type { Page } from '@agentforge/contracts';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { projects } from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { isUniqueViolation } from '../../../platform/database/errors';
import { executor } from '../../../platform/database/transaction';
import { conflict, notFound } from '../../../shared-kernel/errors';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type {
  Project,
  ProjectListFilter,
  ProjectRepository,
} from '../application/project-use-cases';

export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async create(project: Project): Promise<void> {
    try {
      await executor(this.db).insert(projects).values(project);
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict('PROJECT_SLUG_TAKEN', 'A project with this URL already exists');
      throw error;
    }
  }

  async findById(id: string): Promise<Project | null> {
    const [row] = await executor(this.db)
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return row ?? null;
  }

  async slugExists(organizationId: string, slug: string): Promise<boolean> {
    const [row] = await executor(this.db)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.slug, slug)))
      .limit(1);
    return Boolean(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'archivedAt'>>,
    now: Date,
  ): Promise<Project> {
    const [row] = await executor(this.db)
      .update(projects)
      .set({ ...patch, updatedAt: now })
      .where(eq(projects.id, id))
      .returning();
    if (!row) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
    return row;
  }

  async list(filter: ProjectListFilter): Promise<Page<Project>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(projects.organizationId, filter.organizationId)];
    if (!filter.includeArchived) conditions.push(isNull(projects.archivedAt));
    if (filter.slug) conditions.push(eq(projects.slug, filter.slug));
    if (cursor) {
      conditions.push(
        or(
          lt(projects.createdAt, cursor.createdAt),
          and(eq(projects.createdAt, cursor.createdAt), lt(projects.id, cursor.id)),
        )!,
      );
    }
    const rows = await executor(this.db)
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(filter.limit + 1);
    return toPage(rows, filter.limit, (row) => row);
  }
}
