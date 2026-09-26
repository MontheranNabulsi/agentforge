import type { Citation, Page, ValidationResult } from '@agentforge/contracts';

export interface ConversationRecord {
  id: string;
  organizationId: string;
  projectId: string;
  agentId: string;
  agentName: string;
  title: string;
  createdBy: string | null;
  createdByName: string | null;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  organizationId: string;
  projectId: string;
  role: 'user' | 'assistant';
  content: string;
  structuredOutput: unknown;
  citations: Citation[];
  validation: ValidationResult | null;
  runId: string | null;
  status: 'complete' | 'failed';
  authorUserId: string | null;
  authorName: string | null;
  myFeedback: number | null;
  createdAt: Date;
}

export interface ConversationRepository {
  insert(
    conversation: Omit<ConversationRecord, 'agentName' | 'createdByName' | 'messageCount'>,
  ): Promise<void>;
  findById(id: string): Promise<ConversationRecord | null>;
  list(filter: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ConversationRecord>>;
  touch(id: string, patch: { lastMessageAt: Date; title?: string }): Promise<void>;
}

export interface MessageRepository {
  insert(message: Omit<MessageRecord, 'authorName' | 'myFeedback'>): Promise<void>;
  findById(id: string, viewerId: string | null): Promise<MessageRecord | null>;
  list(conversationId: string, viewerId: string | null, limit: number): Promise<MessageRecord[]>;
  /** The most recent turns, oldest first, used as the model's conversation history. */
  recentHistory(
    conversationId: string,
    limit: number,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]>;
  setFeedback(
    messageId: string,
    userId: string,
    rating: 1 | -1,
    comment: string | null,
    now: Date,
  ): Promise<void>;
}

/** Just enough of the agents module for a channel: which agent answers. */
export interface AgentDirectory {
  findForProject(projectId: string, agentId?: string): Promise<{ id: string; name: string } | null>;
}
