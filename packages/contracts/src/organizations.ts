import { z } from 'zod';
import { Id, Role, Slug, Timestamp } from './common';

export const OrganizationDto = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  role: Role,
  createdAt: Timestamp,
});
export type OrganizationDto = z.infer<typeof OrganizationDto>;

export const CreateOrganizationInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: Slug.optional(),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationInput>;

export const MemberDto = z.object({
  userId: Id,
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: Timestamp,
});
export type MemberDto = z.infer<typeof MemberDto>;

export const ChangeMemberRoleInput = z.object({ role: Role });

/** Adds an existing AgentForge user (they must have signed up) to the organization. */
export const AddMemberInput = z.object({
  email: z.email().max(254),
  role: Role.exclude(['owner']).default('member'),
});
export type AddMemberInput = z.infer<typeof AddMemberInput>;
export type ChangeMemberRoleInput = z.infer<typeof ChangeMemberRoleInput>;
