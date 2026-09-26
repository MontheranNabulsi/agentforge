import type { ToolGrant, ToolName } from '@agentforge/contracts';
import type { z } from 'zod';
import type { Permission } from '../../../organizations';
import type { RiskLevel, ToolEffect } from '../../domain/approval-policy';
import type { ProjectQueryInput, SourceChunk, SourceRef } from '../shared-types';

export type { ProjectQueryInput, SourceChunk } from '../shared-types';

/**
 * What a tool may touch. Built per run by ToolCapabilityFactory, already bound to the run's
 * organization, project and agent configuration. Tools never receive the database, the
 * container or another project's data: an injected instruction cannot reach what a tool
 * was never handed.
 */
export interface ToolCapabilities {
  knowledge: {
    search(query: string, limit: number): Promise<SourceChunk[]>;
    lookup(titleOrId: string): Promise<{
      id: string;
      title: string;
      status: string;
      chunkCount: number;
      preview: SourceChunk[];
    } | null>;
  };
  project: {
    metadata(): Promise<{
      name: string;
      description: string;
      documentCount: number;
      agentCount: number;
      memberCount: number;
      createdAt: string;
    }>;
    query(query: ProjectQueryInput): Promise<unknown>;
  };
  /** Bound to this agent's host allowlist; SSRF-checked on every connection and redirect. */
  http: {
    request(req: {
      method: string;
      url: string;
      body?: unknown;
    }): Promise<{ status: number; body: unknown; truncated: boolean; url: string }>;
  };
  notes: {
    create(title: string, content: string): Promise<{ documentId: string; title: string }>;
  };
}

export interface ToolContext {
  runId: string;
  projectId: string;
  organizationId: string;
  actorUserId: string;
  grant: ToolGrant;
  signal: AbortSignal;
  capabilities: ToolCapabilities;
  /** Registers retrieved chunks as citable sources and returns their [n] indices. */
  registerSources(chunks: SourceChunk[]): SourceRef[];
  /** Evaluations run write tools in dry-run mode: describe the effect, change nothing. */
  dryRun: boolean;
}

export interface ApprovalPreview {
  title: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface AgentTool<I = Record<string, unknown>, O = unknown> {
  name: ToolName;
  title: string;
  /** What the model reads when deciding whether to call the tool. */
  description: string;
  input: z.ZodType<I>;
  risk: RiskLevel;
  /** http_request is a read for GET and a write otherwise, so effect depends on input. */
  effectFor(input: I): ToolEffect;
  /** The triggering user must hold this permission; the agent acts on their behalf. */
  permission: Permission;
  capabilities: string[];
  timeoutMs: number;
  execute(input: I, ctx: ToolContext): Promise<O>;
  summarizeInput(input: I): string;
  summarizeOutput(output: O): string;
  approvalPreview?(input: I): ApprovalPreview;
}

export type AnyAgentTool = AgentTool<any, any>;
