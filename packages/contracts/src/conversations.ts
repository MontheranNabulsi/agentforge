import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';
import { Citation, RunStatus, ValidationResult } from './runs';

export const ConversationDto = z.object({
  id: Id,
  projectId: Id,
  agentId: Id,
  agentName: z.string(),
  title: z.string(),
  createdBy: z.object({ id: Id, name: z.string() }).nullable(),
  messageCount: z.number().int(),
  activeRunId: Id.nullable(),
  createdAt: Timestamp,
  lastMessageAt: Timestamp.nullable(),
});
export type ConversationDto = z.infer<typeof ConversationDto>;

export const CreateConversationInput = z.object({
  agentId: Id.optional(),
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationInput>;

export const ConversationListQuery = PageQuery;

export const MessageDto = z.object({
  id: Id,
  conversationId: Id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  structuredOutput: z.unknown().nullable(),
  citations: z.array(Citation),
  validation: ValidationResult.nullable(),
  runId: Id.nullable(),
  status: z.enum(['complete', 'failed']),
  author: z.object({ id: Id, name: z.string() }).nullable(),
  myFeedback: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type MessageDto = z.infer<typeof MessageDto>;

export const SendMessageInput = z.object({
  content: z.string().trim().min(1).max(8_000),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const SendMessageResponse = z.object({
  message: MessageDto,
  run: z.object({ id: Id, status: RunStatus }),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const MessageFeedbackInput = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(1_000).optional(),
});
export type MessageFeedbackInput = z.infer<typeof MessageFeedbackInput>;
