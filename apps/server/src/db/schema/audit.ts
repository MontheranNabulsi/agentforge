import { desc, sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, sqlList } from './columns';
import { organizations } from './organizations';

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;

/**
 * Append-only audit trail. A trigger (see migrations) rejects UPDATE and DELETE.
 * Events are written in the same transaction as the change they describe.
 * project_id and run_id are plain uuids on purpose: history must survive the rows it mentions.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name'),
    onBehalfOfUserId: uuid('on_behalf_of_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    runId: uuid('run_id'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_org_created_idx').on(t.organizationId, desc(t.createdAt)),
    index('audit_events_project_created_idx').on(t.projectId, desc(t.createdAt)),
    check('audit_events_actor_type_check', sql.raw(`actor_type IN ${sqlList(ACTOR_TYPES)}`)),
  ],
);
