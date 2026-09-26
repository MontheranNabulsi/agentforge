import { z } from 'zod';
import { Id, Slug, Timestamp } from './common';

export const TOOL_NAMES = [
  'knowledge_search',
  'document_lookup',
  'project_metadata',
  'project_query',
  'calculator',
  'http_request',
  'create_knowledge_note',
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

export const ToolEffect = z.enum(['read', 'external_read', 'write']);
export type ToolEffect = z.infer<typeof ToolEffect>;

export const ToolGrant = z.object({
  tool: ToolName,
  /** Host allowlist for http_request, e.g. ["api.github.com"]. */
  allowedHosts: z.array(z.string().min(1).max(253)).max(20).optional(),
  /** Let http_request use non-GET methods (always behind approval). */
  allowWrite: z.boolean().optional(),
  /** Admin pre-approval for low-risk tools; ignored for high-risk tools. */
  autoApprove: z.boolean().optional(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

export const ModelProfile = z.enum(['fast', 'default']);
export type ModelProfile = z.infer<typeof ModelProfile>;

export const AgentLimits = z.object({
  maxSteps: z.number().int().min(1).max(20).default(8),
  maxToolCalls: z.number().int().min(0).max(30).default(10),
  maxTokens: z.number().int().min(1_000).max(400_000).default(60_000),
  timeoutSeconds: z.number().int().min(10).max(900).default(180),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

export const RetrievalSettings = z.object({
  topK: z.number().int().min(1).max(12).default(6),
});
export type RetrievalSettings = z.infer<typeof RetrievalSettings>;

/** A JSON Schema object the final answer must satisfy (structured-output agents). */
export const OutputSchema = z.record(z.string(), z.unknown());

export const AgentVersionDto = z.object({
  id: Id,
  version: z.number().int(),
  instructions: z.string(),
  modelProfile: ModelProfile,
  temperature: z.number(),
  tools: z.array(ToolGrant),
  limits: AgentLimits,
  retrieval: RetrievalSettings,
  outputSchema: OutputSchema.nullable(),
  promptVersion: z.string(),
  createdAt: Timestamp,
  createdBy: z.object({ id: Id, name: z.string() }).nullable(),
});
export type AgentVersionDto = z.infer<typeof AgentVersionDto>;

export const AgentDto = z.object({
  id: Id,
  projectId: Id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  currentVersion: AgentVersionDto,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AgentDto = z.infer<typeof AgentDto>;

const AgentConfigFields = {
  instructions: z.string().trim().min(10).max(8_000),
  modelProfile: ModelProfile.default('default'),
  temperature: z.number().min(0).max(1).default(0.2),
  tools: z.array(ToolGrant).max(TOOL_NAMES.length).default([]),
  limits: AgentLimits.default({
    maxSteps: 8,
    maxToolCalls: 10,
    maxTokens: 60_000,
    timeoutSeconds: 180,
  }),
  retrieval: RetrievalSettings.default({ topK: 6 }),
  outputSchema: OutputSchema.nullable().default(null),
};

export const CreateAgentInput = z.object({
  name: z.string().trim().min(2).max(60),
  slug: Slug.optional(),
  description: z.string().trim().max(300).default(''),
  ...AgentConfigFields,
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(300).optional(),
  instructions: AgentConfigFields.instructions.optional(),
  modelProfile: ModelProfile.optional(),
  temperature: z.number().min(0).max(1).optional(),
  tools: z.array(ToolGrant).max(TOOL_NAMES.length).optional(),
  limits: AgentLimits.optional(),
  retrieval: RetrievalSettings.optional(),
  outputSchema: OutputSchema.nullable().optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

export const ToolDescriptorDto = z.object({
  name: ToolName,
  title: z.string(),
  description: z.string(),
  effect: ToolEffect,
  capabilities: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
});
export type ToolDescriptorDto = z.infer<typeof ToolDescriptorDto>;
