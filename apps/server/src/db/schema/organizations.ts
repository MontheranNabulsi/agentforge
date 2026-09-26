import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, sqlList, updatedAt } from './columns';
import { users } from './identity';

export const organizations = pgTable('organizations', {
  id: idColumn(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'organization_members_pk', columns: [t.organizationId, t.userId] }),
    index('organization_members_user_idx').on(t.userId),
    check('organization_members_role_check', sql.raw(`role IN ${sqlList(MEMBER_ROLES)}`)),
  ],
);
