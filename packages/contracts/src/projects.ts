import { z } from 'zod';
import { Id, PageQuery, Slug, Timestamp } from './common';

export const ProjectDto = z.object({
  id: Id,
  organizationId: Id,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: Slug.optional(),
  description: z.string().trim().max(500).default(''),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const ProjectListQuery = PageQuery.extend({
  slug: Slug.optional(),
  includeArchived: z.stringbool().default(false),
});
export type ProjectListQuery = z.infer<typeof ProjectListQuery>;
