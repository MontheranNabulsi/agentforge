import type { ConversationDto, MessageDto, Page, RunStatus } from '@agentforge/contracts';
import { forbidden, notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { truncate } from '../../../shared-kernel/text';
import type { RunCompletion, RunCompletionHandler, RunUseCases } from '../../agents';
import type { ProjectAccess } from '../../projects';
import type {
  AgentDirectory,
  ConversationRecord,
  ConversationRepository,
  MessageRecord,
  MessageRepository,
} from './ports';

type NamedActor = Actor & { name?: string };

export const toConversationDto = (
  c: ConversationRecord,
  activeRunId: string | null = null,
): ConversationDto => ({
  id: c.id,
  projectId: c.projectId,
  agentId: c.agentId,
  agentName: c.agentName,
  title: c.title,
  createdBy: c.createdBy ? { id: c.createdBy, name: c.createdByName ?? 'Unknown' } : null,
  messageCount: c.messageCount,
  activeRunId,
  createdAt: c.createdAt.toISOString(),
  lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
});

export const toMessageDto = (m: MessageRecord): MessageDto => ({
  id: m.id,
  conversationId: m.conversationId,
  role: m.role,
  content: m.content,
  structuredOutput: m.structuredOutput ?? null,
  citations: m.citations,
  validation: m.validation,
  runId: m.runId,
  status: m.status,
  author: m.authorUserId ? { id: m.authorUserId, name: m.authorName ?? 'Unknown' } : null,
  myFeedback: m.myFeedback,
  createdAt: m.createdAt.toISOString(),
});

const DEFAULT_TITLE = 'New conversation';

export interface ConversationDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  agents: AgentDirectory;
  runs: RunUseCases;
  activeRuns: (conversationIds: string[]) => Promise<Map<string, string>>;
  projectAccess: ProjectAccess;
  tx: TransactionRunner;
  clock: Clock;
}

/**
 * The chat channel. A message becomes a run; the run's result becomes the assistant message
 * (written by ChatCompletionHandler inside the run's final transaction).
 */
export class ConversationUseCases {
  constructor(private readonly deps: ConversationDeps) {}

  async create(
    actor: NamedActor,
    projectId: string,
    input: { agentId?: string | undefined; title?: string | undefined },
  ): Promise<ConversationRecord> {
    const { project } = await this.deps.projectAccess.require(
      actor,
      projectId,
      'conversation:create',
    );
    const agent = await this.deps.agents.findForProject(projectId, input.agentId);
    if (!agent)
      throw notFound(
        'AGENT_NOT_FOUND',
        input.agentId ? 'Agent not found in this project' : 'This project has no agent yet',
      );
    const now = this.deps.clock.now();
    const record = {
      id: newId(now.getTime()),
      organizationId: project.organizationId,
      projectId,
      agentId: agent.id,
      title: input.title?.trim() || DEFAULT_TITLE,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
    await this.deps.conversations.insert(record);
    return { ...record, agentName: agent.name, createdByName: actor.name ?? null, messageCount: 0 };
  }

  async list(
    actor: Actor,
    projectId: string,
    page: { limit: number; cursor?: string },
  ): Promise<Page<ConversationDto>> {
    await this.deps.projectAccess.require(actor, projectId, 'conversation:read');
    const result = await this.deps.conversations.list({ projectId, ...page });
    const active = await this.deps.activeRuns(result.data.map((c) => c.id));
    return {
      data: result.data.map((c) => toConversationDto(c, active.get(c.id) ?? null)),
      page: result.page,
    };
  }

  async get(actor: Actor, conversationId: string): Promise<ConversationDto> {
    const conversation = await this.load(actor, conversationId, 'conversation:read');
    const active = await this.deps.activeRuns([conversation.id]);
    return toConversationDto(conversation, active.get(conversation.id) ?? null);
  }

  async messages(actor: Actor, conversationId: string, limit: number): Promise<MessageRecord[]> {
    await this.load(actor, conversationId, 'conversation:read');
    return this.deps.messages.list(conversationId, actor.userId, limit);
  }

  /**
   * Saves the user's message and starts the agent run in one transaction. The database allows
   * one active run per conversation, so a second message while the agent is still working is
   * answered with 409 RUN_IN_PROGRESS and nothing is saved.
   */
  async sendMessage(
    actor: NamedActor,
    conversationId: string,
    content: string,
    requestId: string | null,
  ): Promise<{ message: MessageRecord; run: { id: string; status: RunStatus } }> {
    const conversation = await this.load(actor, conversationId, 'conversation:create');
    const { messages, conversations, runs, tx, clock } = this.deps;
    return tx.run(async () => {
      const history = await messages.recentHistory(conversation.id, 12);
      const now = clock.now();
      const message: Omit<MessageRecord, 'authorName' | 'myFeedback'> = {
        id: newId(now.getTime()),
        conversationId: conversation.id,
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        role: 'user',
        content,
        structuredOutput: null,
        citations: [],
        validation: null,
        runId: null,
        status: 'complete',
        authorUserId: actor.userId,
        createdAt: now,
      };
      await messages.insert(message);
      const run = await runs.startRun({
        actor,
        projectId: conversation.projectId,
        agentId: conversation.agentId,
        trigger: 'chat',
        triggerRefId: conversation.id,
        input: content,
        history,
        enqueue: true,
        requestId,
      });
      await conversations.touch(conversation.id, {
        lastMessageAt: now,
        ...(conversation.title === DEFAULT_TITLE && history.length === 0
          ? { title: truncate(content.replace(/\s+/g, ' ').trim(), 60) }
          : {}),
      });
      return {
        message: { ...message, runId: null, authorName: actor.name ?? null, myFeedback: null },
        run: { id: run.id, status: run.status },
      };
    });
  }

  async feedback(
    actor: Actor,
    messageId: string,
    input: { rating: 1 | -1; comment?: string | undefined },
  ): Promise<MessageRecord> {
    const message = await this.deps.messages.findById(messageId, actor.userId);
    if (!message) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
    await this.deps.projectAccess.require(actor, message.projectId, 'conversation:create');
    if (message.role !== 'assistant')
      throw forbidden('FEEDBACK_ASSISTANT_ONLY', 'Only agent answers can be rated');
    await this.deps.messages.setFeedback(
      messageId,
      actor.userId,
      input.rating,
      input.comment?.trim() || null,
      this.deps.clock.now(),
    );
    return (await this.deps.messages.findById(messageId, actor.userId))!;
  }

  private async load(
    actor: Actor,
    conversationId: string,
    permission: 'conversation:read' | 'conversation:create',
  ): Promise<ConversationRecord> {
    const conversation = await this.deps.conversations.findById(conversationId);
    if (!conversation) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    await this.deps.projectAccess.require(actor, conversation.projectId, permission);
    return conversation;
  }
}

/** Writes the assistant's reply when a chat run ends (inside the run's final transaction). */
export class ChatCompletionHandler implements RunCompletionHandler {
  constructor(
    private readonly deps: {
      conversations: ConversationRepository;
      messages: MessageRepository;
      clock: Clock;
    },
  ) {}

  async onRunFinished(completion: RunCompletion): Promise<{ messageId: string | null }> {
    const { run, status, output, error } = completion;
    if (!run.triggerRefId) return { messageId: null };
    const now = this.deps.clock.now();
    const content =
      status === 'completed' && output
        ? output.text
        : status === 'cancelled'
          ? 'Stopped: the run was cancelled.'
          : status === 'timed_out'
            ? 'The agent ran out of time before finishing. Try a narrower request.'
            : `The agent couldn't finish this request (${error?.code ?? 'error'}): ${error?.message ?? 'unknown error'}`;
    const id = newId(now.getTime());
    await this.deps.messages.insert({
      id,
      conversationId: run.triggerRefId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      role: 'assistant',
      content,
      structuredOutput: output?.structured ?? null,
      citations: output?.citations ?? [],
      validation: output?.validation ?? null,
      runId: run.id,
      status: status === 'completed' ? 'complete' : 'failed',
      authorUserId: null,
      createdAt: now,
    });
    await this.deps.conversations.touch(run.triggerRefId, { lastMessageAt: now });
    return { messageId: id };
  }
}
