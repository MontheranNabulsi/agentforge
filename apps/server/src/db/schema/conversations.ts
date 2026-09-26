import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentRuns, agents } from './agents';
import { createdAt, idColumn, ts, updatedAt } from './columns';
import { users } from './identity';
import { projectTenantFk } from './projects';

export const conversations = pgTable(
  'conversations',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastMessageAt: ts('last_message_at'),
  },
  (t) => [
    projectTenantFk('conversations_project_tenant_fk', t.projectId, t.organizationId),
    index('conversations_project_recent_idx').on(
      t.projectId,
      sql`${t.lastMessageAt} DESC NULLS LAST`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: idColumn(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    structuredOutput: jsonb('structured_output'),
    /** Snapshots of cited passages: history must not change when a document is deleted. */
    citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
    validation: jsonb('validation'),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('complete'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('messages_run_idx').on(t.runId),
    check('messages_role_check', sql.raw(`role IN ('user', 'assistant')`)),
    check('messages_status_check', sql.raw(`status IN ('complete', 'failed')`)),
  ],
);

export const messageFeedback = pgTable(
  'message_feedback',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'message_feedback_pk', columns: [t.messageId, t.userId] }),
    check('message_feedback_rating_check', sql`${t.rating} IN (-1, 1)`),
  ],
);
