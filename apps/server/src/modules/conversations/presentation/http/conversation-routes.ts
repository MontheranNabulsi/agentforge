import {
  ConversationDto,
  ConversationListQuery,
  CreateConversationInput,
  Id,
  MessageDto,
  MessageFeedbackInput,
  pageOf,
  SendMessageInput,
  SendMessageResponse,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import { IdempotencyStore } from '../../../../platform/http/idempotency';
import type { App } from '../../../../platform/http/server';
import {
  toConversationDto,
  toMessageDto,
  type ConversationUseCases,
} from '../../application/conversation-use-cases';

const ProjectParams = z.object({ projectId: Id });
const ConversationParams = z.object({ conversationId: Id });
const MessageParams = z.object({ messageId: Id });

export function conversationRoutes(deps: {
  conversations: ConversationUseCases;
  idempotency: IdempotencyStore;
}) {
  const { conversations, idempotency } = deps;
  const named = (request: Parameters<typeof requireActor>[0]) => ({
    ...requireActor(request),
    name: request.auth!.user.name,
  });

  return async (api: App) => {
    api.get(
      '/projects/:projectId/conversations',
      {
        schema: {
          tags: ['conversations'],
          params: ProjectParams,
          querystring: ConversationListQuery,
          response: { 200: pageOf(ConversationDto) },
        },
      },
      async (request) =>
        conversations.list(requireActor(request), request.params.projectId, {
          limit: request.query.limit,
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        }),
    );

    api.post(
      '/projects/:projectId/conversations',
      {
        schema: {
          tags: ['conversations'],
          params: ProjectParams,
          body: CreateConversationInput,
          response: { 201: ConversationDto },
        },
      },
      async (request, reply) => {
        const conversation = await conversations.create(
          named(request),
          request.params.projectId,
          request.body,
        );
        return reply.status(201).send(toConversationDto(conversation));
      },
    );

    api.get(
      '/conversations/:conversationId',
      {
        schema: {
          tags: ['conversations'],
          params: ConversationParams,
          response: { 200: ConversationDto },
        },
      },
      async (request) => conversations.get(requireActor(request), request.params.conversationId),
    );

    api.get(
      '/conversations/:conversationId/messages',
      {
        schema: {
          tags: ['conversations'],
          params: ConversationParams,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
          response: { 200: z.array(MessageDto) },
        },
      },
      async (request) =>
        (
          await conversations.messages(
            requireActor(request),
            request.params.conversationId,
            request.query.limit,
          )
        ).map(toMessageDto),
    );

    api.post(
      '/conversations/:conversationId/messages',
      {
        schema: {
          tags: ['conversations'],
          summary:
            'Send a message; the agent run starts in the background. Stream it from /runs/{runId}/events. Supports Idempotency-Key.',
          params: ConversationParams,
          body: SendMessageInput,
          response: { 202: SendMessageResponse },
        },
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        const actor = named(request);
        const key = IdempotencyStore.keyFrom(request, false);
        const scope = `POST /conversations/${request.params.conversationId}/messages`;
        const result = await idempotency.execute({
          userId: actor.userId,
          key,
          scope,
          requestHash: IdempotencyStore.fingerprint(scope, request.body),
          work: async () => {
            const sent = await conversations.sendMessage(
              actor,
              request.params.conversationId,
              request.body.content,
              String(request.id),
            );
            return { status: 202, body: { message: toMessageDto(sent.message), run: sent.run } };
          },
        });
        if (result.replayed) void reply.header('idempotent-replayed', 'true');
        return reply.status(result.status as 202).send(result.body);
      },
    );

    api.put(
      '/messages/:messageId/feedback',
      {
        schema: {
          tags: ['conversations'],
          summary: 'Rate an answer (thumbs up/down)',
          params: MessageParams,
          body: MessageFeedbackInput,
          response: { 200: MessageDto },
        },
      },
      async (request) =>
        toMessageDto(
          await conversations.feedback(
            requireActor(request),
            request.params.messageId,
            request.body,
          ),
        ),
    );
  };
}
