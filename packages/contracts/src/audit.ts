import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';

export const ActorType = z.enum(['user', 'agent', 'system']);

export const AuditEventDto = z.object({
  id: Id,
  organizationId: Id,
  projectId: Id.nullable(),
  actorType: ActorType,
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  onBehalfOfUserId: Id.nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  runId: Id.nullable(),
  createdAt: Timestamp,
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const AuditListQuery = PageQuery.extend({
  projectId: Id.optional(),
  action: z.string().max(80).optional(),
  actorId: Id.optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;
