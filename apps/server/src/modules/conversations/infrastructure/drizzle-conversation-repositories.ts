import type { Citation, Page, ValidationResult } from '@agentforge/contracts';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import { agents, conversations, messageFeedback, messages, users } from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { executor } from '../../../platform/database/transaction';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type {
  ConversationRecord,
  ConversationRepository,
  MessageRecord,
  MessageRepository,
} from '../application/ports';

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select({
        conversation: conversations,
        agentName: agents.name,
        createdByName: users.name,
        messageCount: sql<number>`(SELECT count(*)::int FROM messages m WHERE m.conversation_id = "conversations"."id")`,
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(users, eq(users.id, conversations.createdBy));
  }

  private toRecord(row: {
    conversation: typeof conversations.$inferSelect;
    agentName: string;
    createdByName: string | null;
    messageCount: number;
  }): ConversationRecord {
    return {
      ...row.conversation,
      agentName: row.agentName,
      createdByName: row.createdByName,
      messageCount: Number(row.messageCount),
    };
  }

  async insert(
    conversation: Omit<ConversationRecord, 'agentName' | 'createdByName' | 'messageCount'>,
  ): Promise<void> {
    await executor(this.db).insert(conversations).values(conversation);
  }

  async findById(id: string): Promise<ConversationRecord | null> {
    const [row] = await this.select().where(eq(conversations.id, id)).limit(1);
    return row ? this.toRecord(row) : null;
  }

  async list(filter: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ConversationRecord>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(conversations.projectId, filter.projectId)];
    if (cursor) {
      conditions.push(
        or(
          lt(conversations.createdAt, cursor.createdAt),
          and(eq(conversations.createdAt, cursor.createdAt), lt(conversations.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(filter.limit + 1);
    return toPage(
      rows.map((r) => this.toRecord(r)),
      filter.limit,
      (r) => r,
    );
  }

  async touch(id: string, patch: { lastMessageAt: Date; title?: string }): Promise<void> {
    await executor(this.db)
      .update(conversations)
      .set({
        lastMessageAt: patch.lastMessageAt,
        updatedAt: patch.lastMessageAt,
        ...(patch.title ? { title: patch.title } : {}),
      })
      .where(eq(conversations.id, id));
  }
}

export class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly db: Database) {}

  private select(viewerId: string | null) {
    return executor(this.db)
      .select({
        message: messages,
        authorName: users.name,
        myFeedback: messageFeedback.rating,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(
        messageFeedback,
        and(
          eq(messageFeedback.messageId, messages.id),
          viewerId ? eq(messageFeedback.userId, viewerId) : sql`false`,
        ),
      );
  }

  private toRecord(row: {
    message: typeof messages.$inferSelect;
    authorName: string | null;
    myFeedback: number | null;
  }): MessageRecord {
    return {
      ...row.message,
      role: row.message.role as MessageRecord['role'],
      status: row.message.status as MessageRecord['status'],
      citations: (row.message.citations ?? []) as Citation[],
      validation: (row.message.validation as ValidationResult | null) ?? null,
      structuredOutput: row.message.structuredOutput ?? null,
      authorName: row.authorName,
      myFeedback: row.myFeedback ?? null,
    };
  }

  async insert(message: Omit<MessageRecord, 'authorName' | 'myFeedback'>): Promise<void> {
    await executor(this.db).insert(messages).values(message);
  }

  async findById(id: string, viewerId: string | null): Promise<MessageRecord | null> {
    const [row] = await this.select(viewerId).where(eq(messages.id, id)).limit(1);
    return row ? this.toRecord(row) : null;
  }

  async list(
    conversationId: string,
    viewerId: string | null,
    limit: number,
  ): Promise<MessageRecord[]> {
    const rows = await this.select(viewerId)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return rows.map((r) => this.toRecord(r)).reverse();
  }

  async recentHistory(
    conversationId: string,
    limit: number,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = await executor(this.db)
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, 'complete')))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return rows
      .reverse()
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  async setFeedback(
    messageId: string,
    userId: string,
    rating: 1 | -1,
    comment: string | null,
    now: Date,
  ): Promise<void> {
    await executor(this.db)
      .insert(messageFeedback)
      .values({ messageId, userId, rating, comment, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [messageFeedback.messageId, messageFeedback.userId],
        set: { rating, comment, updatedAt: now },
      });
  }
}
