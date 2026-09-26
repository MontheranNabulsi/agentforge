import { desc } from 'drizzle-orm';
import {
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn, ts, updatedAt } from './columns';
import { users } from './identity';
import { organizations } from './organizations';

export const projects = pgTable(
  'projects',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    unique('projects_org_slug_unique').on(t.organizationId, t.slug),
    // Target for composite foreign keys: lets child tables prove their organization
    // matches their project's organization (tenant integrity in the database itself).
    unique('projects_id_org_unique').on(t.id, t.organizationId),
    index('projects_org_created_idx').on(t.organizationId, desc(t.createdAt)),
  ],
);

/**
 * Every project-scoped table stores organization_id and project_id and declares this
 * composite foreign key, so a row can never point at a project in another organization.
 */
export const projectTenantFk = (
  name: string,
  projectId: AnyPgColumn,
  organizationId: AnyPgColumn,
) =>
  foreignKey({
    name,
    columns: [projectId, organizationId],
    foreignColumns: [projects.id, projects.organizationId],
  }).onDelete('cascade');
