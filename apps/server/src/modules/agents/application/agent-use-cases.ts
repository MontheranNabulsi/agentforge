import type {
  AgentDto,
  AgentVersionDto,
  CreateAgentInput,
  ToolDescriptorDto,
  ToolGrant,
  UpdateAgentInput,
} from '@agentforge/contracts';
import {
  conflict,
  notFound,
  preconditionFailed,
  validationError,
} from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { slugify } from '../../../shared-kernel/text';
import type { AuditLog } from '../../audit';
import type { ProjectAccess } from '../../projects';
import type {
  AgentRecord,
  AgentRepository,
  AgentVersionRecord,
  AgentWithVersion,
  OutputSchemaValidator,
} from './ports';
import { PROMPT_VERSION } from './prompts';
import type { ToolRegistry } from './tools/builtin-tools';

type NamedActor = Actor & { name?: string };

export const DEFAULT_AGENT_INSTRUCTIONS = `You are this project's assistant.
- Answer questions from the project's documents and cite the passages you use.
- Use the calculator for arithmetic and project_query for questions about project activity (runs, documents, approvals).
- When someone asks you to remember or note something, save it with create_knowledge_note; a person reviews it first.
- If the documents don't cover a question, say so instead of guessing.`;

export const DEFAULT_TOOL_GRANTS: ToolGrant[] = [
  { tool: 'knowledge_search' },
  { tool: 'document_lookup' },
  { tool: 'project_metadata' },
  { tool: 'project_query' },
  { tool: 'calculator' },
  { tool: 'http_request', allowedHosts: ['api.github.com', 'httpbin.org'], allowWrite: true },
  { tool: 'create_knowledge_note' },
];

export const toAgentVersionDto = (v: AgentVersionRecord): AgentVersionDto => ({
  id: v.id,
  version: v.version,
  instructions: v.instructions,
  modelProfile: v.modelProfile,
  temperature: v.temperature,
  tools: v.tools,
  limits: v.limits,
  retrieval: v.retrieval,
  outputSchema: v.outputSchema,
  promptVersion: v.promptVersion,
  createdAt: v.createdAt.toISOString(),
  createdBy: v.createdBy ? { id: v.createdBy, name: v.createdByName ?? 'Unknown' } : null,
});

export const toAgentDto = (a: AgentWithVersion): AgentDto => ({
  id: a.id,
  projectId: a.projectId,
  slug: a.slug,
  name: a.name,
  description: a.description,
  isDefault: a.isDefault,
  currentVersion: toAgentVersionDto(a.currentVersion),
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

/** Weak ETag over the version number: editing an agent always creates a new version. */
export const agentEtag = (a: AgentWithVersion) => `W/"agent-${a.id}-v${a.currentVersion.version}"`;

export interface AgentUseCaseDeps {
  agents: AgentRepository;
  projectAccess: ProjectAccess;
  registry: ToolRegistry;
  validator: OutputSchemaValidator;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
}

export class AgentUseCases {
  constructor(private readonly deps: AgentUseCaseDeps) {}

  tools(): ToolDescriptorDto[] {
    return this.deps.registry.describe();
  }

  async list(actor: Actor, projectId: string): Promise<AgentWithVersion[]> {
    await this.deps.projectAccess.require(actor, projectId, 'agent:read');
    return this.deps.agents.list(projectId);
  }

  async get(actor: Actor, agentId: string): Promise<AgentWithVersion> {
    const agent = await this.deps.agents.findById(agentId);
    if (!agent || agent.archivedAt) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    await this.deps.projectAccess.require(actor, agent.projectId, 'agent:read');
    return agent;
  }

  async versions(actor: Actor, agentId: string): Promise<AgentVersionRecord[]> {
    await this.get(actor, agentId);
    return this.deps.agents.listVersions(agentId);
  }

  /** Hook for ProjectUseCases.create: every new project starts with a working assistant. */
  readonly onProjectCreated = async (
    project: { id: string; organizationId: string },
    actor: Actor,
  ): Promise<void> => {
    await this.insert(
      { ...actor },
      { id: project.id, organizationId: project.organizationId },
      {
        name: 'Project Assistant',
        slug: 'assistant',
        description:
          'Answers from project documents, runs calculations and project queries, and saves approved notes.',
        instructions: DEFAULT_AGENT_INSTRUCTIONS,
        modelProfile: 'default',
        temperature: 0.2,
        tools: DEFAULT_TOOL_GRANTS,
        limits: { maxSteps: 8, maxToolCalls: 10, maxTokens: 60_000, timeoutSeconds: 180 },
        retrieval: { topK: 6 },
        outputSchema: null,
      },
      true,
    );
  };

  async create(
    actor: NamedActor,
    projectId: string,
    input: CreateAgentInput,
  ): Promise<AgentWithVersion> {
    const { project } = await this.deps.projectAccess.require(actor, projectId, 'agent:manage');
    this.assertConfig(input.tools, input.outputSchema);
    const id = await this.deps.tx.run(async () => {
      const slug = input.slug ?? (await this.availableSlug(projectId, input.name));
      if (input.slug && (await this.deps.agents.slugExists(projectId, input.slug))) {
        throw conflict('AGENT_SLUG_TAKEN', 'An agent with this slug already exists in the project');
      }
      const hasDefault = (await this.deps.agents.findDefault(projectId)) !== null;
      return this.insert(
        actor,
        { id: projectId, organizationId: project.organizationId },
        { ...input, slug },
        !hasDefault,
      );
    });
    return (await this.deps.agents.findById(id))!;
  }

  /**
   * Configuration changes create version n+1 (runs keep pointing at the version they used).
   * If-Match makes concurrent edits explicit: the second writer gets 412 instead of silently
   * overwriting the first.
   */
  async update(
    actor: NamedActor,
    agentId: string,
    input: UpdateAgentInput,
    ifMatch: string | null,
  ): Promise<AgentWithVersion> {
    const { agents, tx, clock, audit } = this.deps;
    const agent = await agents.findById(agentId);
    if (!agent || agent.archivedAt) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    await this.deps.projectAccess.require(actor, agent.projectId, 'agent:manage');
    if (ifMatch && ifMatch !== agentEtag(agent)) {
      throw preconditionFailed(
        'AGENT_VERSION_CHANGED',
        'The agent was changed by someone else; reload and try again',
      );
    }
    if (input.tools || input.outputSchema !== undefined)
      this.assertConfig(input.tools ?? agent.currentVersion.tools, input.outputSchema ?? null);

    await tx.run(async () => {
      const now = clock.now();
      const current = agent.currentVersion;
      const configChanged =
        (input.instructions !== undefined && input.instructions !== current.instructions) ||
        (input.modelProfile !== undefined && input.modelProfile !== current.modelProfile) ||
        (input.temperature !== undefined && input.temperature !== current.temperature) ||
        (input.tools !== undefined &&
          JSON.stringify(input.tools) !== JSON.stringify(current.tools)) ||
        (input.limits !== undefined &&
          JSON.stringify(input.limits) !== JSON.stringify(current.limits)) ||
        (input.retrieval !== undefined &&
          JSON.stringify(input.retrieval) !== JSON.stringify(current.retrieval)) ||
        (input.outputSchema !== undefined &&
          JSON.stringify(input.outputSchema) !== JSON.stringify(current.outputSchema));
      if (configChanged) {
        try {
          await agents.addVersion({
            id: newId(now.getTime()),
            agentId: agent.id,
            organizationId: agent.organizationId,
            projectId: agent.projectId,
            version: current.version + 1,
            instructions: input.instructions ?? current.instructions,
            modelProfile: input.modelProfile ?? current.modelProfile,
            temperature: input.temperature ?? current.temperature,
            tools: input.tools ?? current.tools,
            limits: input.limits ?? current.limits,
            retrieval: input.retrieval ?? current.retrieval,
            outputSchema:
              input.outputSchema === undefined ? current.outputSchema : input.outputSchema,
            promptVersion: PROMPT_VERSION,
            createdBy: actor.userId,
            createdAt: now,
          });
        } catch (error) {
          if ((error as { code?: string }).code === 'AGENT_VERSION_CONFLICT') {
            throw preconditionFailed(
              'AGENT_VERSION_CHANGED',
              'The agent was changed by someone else; reload and try again',
            );
          }
          throw error;
        }
      }
      if (input.isDefault === true && !agent.isDefault) await agents.clearDefault(agent.projectId);
      await agents.update(
        agent.id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isDefault === true ? { isDefault: true } : {}),
        },
        now,
      );
      await audit.record({
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: 'agent.updated',
        target: { type: 'agent', id: agent.id },
        metadata: {
          fields: Object.keys(input),
          newVersion: configChanged ? current.version + 1 : null,
        },
      });
    });
    return (await agents.findById(agent.id))!;
  }

  private assertConfig(tools: ToolGrant[], outputSchema: Record<string, unknown> | null) {
    const names = tools.map((t) => t.tool);
    if (new Set(names).size !== names.length)
      throw validationError('DUPLICATE_TOOL_GRANT', 'Each tool can be granted once');
    const http = tools.find((t) => t.tool === 'http_request');
    if (http && (!http.allowedHosts || http.allowedHosts.length === 0)) {
      throw validationError('HTTP_HOSTS_REQUIRED', 'http_request needs at least one allowed host', [
        { path: 'tools', message: 'Add allowedHosts for http_request' },
      ]);
    }
    for (const host of http?.allowedHosts ?? []) {
      if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
        throw validationError(
          'HTTP_HOST_INVALID',
          `"${host}" is not a valid host name (IP addresses are not allowed)`,
        );
      }
    }
    if (outputSchema) {
      const problem = this.deps.validator.check(outputSchema);
      if (problem)
        throw validationError(
          'OUTPUT_SCHEMA_INVALID',
          `The output schema is not valid JSON Schema: ${problem}`,
        );
    }
  }

  private async insert(
    actor: NamedActor,
    project: { id: string; organizationId: string },
    input: Omit<CreateAgentInput, 'slug'> & { slug: string },
    isDefault: boolean,
  ): Promise<string> {
    const now = this.deps.clock.now();
    const agent: AgentRecord = {
      id: newId(now.getTime()),
      organizationId: project.organizationId,
      projectId: project.id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      isDefault,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    await this.deps.agents.create(agent, {
      id: newId(now.getTime()),
      agentId: agent.id,
      organizationId: project.organizationId,
      projectId: project.id,
      version: 1,
      instructions: input.instructions,
      modelProfile: input.modelProfile,
      temperature: input.temperature,
      tools: input.tools,
      limits: input.limits,
      retrieval: input.retrieval,
      outputSchema: input.outputSchema,
      promptVersion: PROMPT_VERSION,
      createdBy: actor.userId,
      createdAt: now,
    });
    await this.deps.audit.record({
      organizationId: project.organizationId,
      projectId: project.id,
      actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
      action: 'agent.created',
      target: { type: 'agent', id: agent.id },
      metadata: { name: agent.name, tools: input.tools.map((t) => t.tool) },
    });
    return agent.id;
  }

  private async availableSlug(projectId: string, name: string): Promise<string> {
    const base = slugify(name, 40) || 'agent';
    if (!(await this.deps.agents.slugExists(projectId, base))) return base;
    for (let i = 2; i < 50; i += 1) {
      if (!(await this.deps.agents.slugExists(projectId, `${base}-${i}`))) return `${base}-${i}`;
    }
    return `${base}-${newId().slice(-6)}`;
  }
}
