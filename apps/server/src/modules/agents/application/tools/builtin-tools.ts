import type { ToolDescriptorDto, ToolName } from '@agentforge/contracts';
import { z } from 'zod';
import { truncate } from '../../../../shared-kernel/text';
import { evaluateExpression } from '../../domain/calculator';
import type { AgentTool, AnyAgentTool } from './agent-tool';

// ---------------------------------------------------------------------------------------
// knowledge_search
// ---------------------------------------------------------------------------------------

const KnowledgeSearchInput = z.object({
  query: z.string().trim().min(2).max(300).describe('What to look for, in plain words'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('How many passages to return (default 5)'),
});

const knowledgeSearch: AgentTool<z.infer<typeof KnowledgeSearchInput>, { results: unknown[] }> = {
  name: 'knowledge_search',
  title: 'Knowledge search',
  description:
    "Search this project's documents (hybrid keyword + semantic search). Returns passages with a sourceIndex; cite them as [sourceIndex].",
  input: KnowledgeSearchInput,
  risk: 'low',
  effectFor: () => 'read',
  permission: 'document:read',
  capabilities: ['knowledge:read'],
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const chunks = await ctx.capabilities.knowledge.search(input.query, input.limit ?? 5);
    const refs = ctx.registerSources(chunks);
    return {
      results: refs.map((ref) => ({
        sourceIndex: ref.index,
        documentTitle: ref.documentTitle,
        headingPath: ref.headingPath,
        pageNumber: ref.pageNumber,
        content: truncate(ref.content, 1_200),
        chunkId: ref.chunkId,
        documentId: ref.documentId,
      })),
    };
  },
  summarizeInput: (input) => `"${truncate(input.query, 80)}"`,
  summarizeOutput: (output) =>
    `${output.results.length} passage${output.results.length === 1 ? '' : 's'}`,
};

// ---------------------------------------------------------------------------------------
// document_lookup
// ---------------------------------------------------------------------------------------

const DocumentLookupInput = z.object({
  title: z.string().trim().min(2).max(200).describe('Document title (partial match) or id'),
});

const documentLookup: AgentTool<z.infer<typeof DocumentLookupInput>, Record<string, unknown>> = {
  name: 'document_lookup',
  title: 'Document lookup',
  description:
    'Open one project document by title or id: status, size and its first passages (citable).',
  input: DocumentLookupInput,
  risk: 'low',
  effectFor: () => 'read',
  permission: 'document:read',
  capabilities: ['knowledge:read'],
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const found = await ctx.capabilities.knowledge.lookup(input.title);
    if (!found) return { found: false, message: `No document matching "${input.title}"` };
    const refs = ctx.registerSources(found.preview);
    return {
      found: true,
      title: found.title,
      status: found.status,
      chunkCount: found.chunkCount,
      passages: refs.map((ref) => ({
        sourceIndex: ref.index,
        documentTitle: ref.documentTitle,
        headingPath: ref.headingPath,
        pageNumber: ref.pageNumber,
        content: truncate(ref.content, 800),
        chunkId: ref.chunkId,
        documentId: ref.documentId,
      })),
    };
  },
  summarizeInput: (input) => `"${truncate(input.title, 80)}"`,
  summarizeOutput: (output) => (output.found ? `found "${String(output.title)}"` : 'not found'),
};

// ---------------------------------------------------------------------------------------
// project_metadata
// ---------------------------------------------------------------------------------------

const ProjectMetadataInput = z.object({});

const projectMetadata: AgentTool<z.infer<typeof ProjectMetadataInput>, Record<string, unknown>> = {
  name: 'project_metadata',
  title: 'Project metadata',
  description: 'Name, description and size of the current project (documents, agents, members).',
  input: ProjectMetadataInput,
  risk: 'low',
  effectFor: () => 'read',
  permission: 'project:read',
  capabilities: ['project:read'],
  timeoutMs: 5_000,
  execute: (_input, ctx) => ctx.capabilities.project.metadata(),
  summarizeInput: () => 'current project',
  summarizeOutput: (output) =>
    `${String(output.documentCount)} documents, ${String(output.agentCount)} agents`,
};

// ---------------------------------------------------------------------------------------
// project_query: a constrained query language, never model-written SQL
// ---------------------------------------------------------------------------------------

const ProjectQueryInputSchema = z.object({
  entity: z.enum(['agent_runs', 'documents', 'conversations', 'tool_calls', 'approvals']),
  aggregate: z.enum(['count', 'list']).default('count'),
  status: z
    .string()
    .max(40)
    .optional()
    .describe('Filter by status, e.g. failed, completed, indexed, pending'),
  since: z.enum(['24h', '7d', '30d', 'all']).default('7d'),
  groupBy: z.enum(['status', 'day', 'tool', 'agent']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const projectQuery: AgentTool<z.infer<typeof ProjectQueryInputSchema>, unknown> = {
  name: 'project_query',
  title: 'Project query',
  description:
    'Count or list records in this project: agent_runs, documents, conversations, tool_calls, approvals. ' +
    'Filter by status and time window (24h, 7d, 30d, all); optionally group by status, day, tool or agent.',
  input: ProjectQueryInputSchema,
  risk: 'low',
  effectFor: () => 'read',
  permission: 'run:read',
  capabilities: ['project:read'],
  timeoutMs: 10_000,
  execute: (input, ctx) => ctx.capabilities.project.query(input),
  summarizeInput: (input) =>
    `${input.aggregate} ${input.entity}${input.status ? ` status=${input.status}` : ''} since=${input.since}${input.groupBy ? ` by ${input.groupBy}` : ''}`,
  summarizeOutput: (output) => {
    const o = output as { count?: number; rows?: unknown[]; groups?: unknown[] };
    if (typeof o.count === 'number') return `count = ${o.count}`;
    if (o.groups) return `${o.groups.length} groups`;
    return `${o.rows?.length ?? 0} rows`;
  },
};

// ---------------------------------------------------------------------------------------
// calculator
// ---------------------------------------------------------------------------------------

const CalculatorInput = z.object({
  expression: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Arithmetic such as "1840 * 0.15" or "sqrt(2) ^ 2"'),
});

const calculator: AgentTool<
  z.infer<typeof CalculatorInput>,
  { expression: string; result: number }
> = {
  name: 'calculator',
  title: 'Calculator',
  description:
    'Evaluate an arithmetic expression exactly (+ - * / % ^, parentheses, sqrt, round, min, max, log, pi).',
  input: CalculatorInput,
  risk: 'low',
  effectFor: () => 'read',
  permission: 'run:create',
  capabilities: [],
  timeoutMs: 1_000,
  execute: async (input) => ({
    expression: input.expression,
    result: evaluateExpression(input.expression),
  }),
  summarizeInput: (input) => input.expression,
  summarizeOutput: (output) => `= ${Number(output.result.toFixed(6))}`,
};

// ---------------------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------------------

const HttpRequestInput = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.url().max(2_000).describe('Absolute https URL on an allowlisted host'),
  body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH'),
});

const httpRequest: AgentTool<z.infer<typeof HttpRequestInput>, Record<string, unknown>> = {
  name: 'http_request',
  title: 'HTTP request',
  description:
    'Call an HTTP API on a host this agent is allowed to reach. GET runs directly; POST/PUT/PATCH/DELETE require human approval.',
  input: HttpRequestInput,
  risk: 'medium',
  effectFor: (input) => (input.method === 'GET' ? 'external_read' : 'write'),
  permission: 'run:create',
  capabilities: ['http:get', 'http:write'],
  timeoutMs: 15_000,
  async execute(input, ctx) {
    if (ctx.dryRun && input.method !== 'GET') {
      return { dryRun: true, wouldSend: `${input.method} ${input.url}` };
    }
    const response = await ctx.capabilities.http.request({
      method: input.method,
      url: input.url,
      body: input.body,
    });
    return {
      status: response.status,
      url: response.url,
      body: response.body,
      truncated: response.truncated,
    };
  },
  summarizeInput: (input) => `${input.method} ${truncate(input.url, 100)}`,
  summarizeOutput: (output) =>
    output.dryRun ? 'dry run: not sent' : `HTTP ${String(output.status)}`,
  approvalPreview: (input) => ({
    title: `${input.method} request to ${new URL(input.url).host}`,
    summary: `The agent wants to send ${input.method} ${input.url}.`,
    payload: { method: input.method, url: input.url, body: input.body ?? null },
  }),
};

// ---------------------------------------------------------------------------------------
// create_knowledge_note
// ---------------------------------------------------------------------------------------

const NoteInput = z.object({
  title: z.string().trim().min(3).max(120),
  content: z.string().trim().min(10).max(4_000),
});

const createKnowledgeNote: AgentTool<z.infer<typeof NoteInput>, Record<string, unknown>> = {
  name: 'create_knowledge_note',
  title: 'Create knowledge note',
  description:
    'Save a short note into this project knowledge base so future answers can cite it. Always requires human approval.',
  input: NoteInput,
  risk: 'medium',
  effectFor: () => 'write',
  permission: 'document:upload',
  capabilities: ['knowledge:write'],
  timeoutMs: 15_000,
  async execute(input, ctx) {
    if (ctx.dryRun) return { dryRun: true, wouldCreate: input.title };
    const note = await ctx.capabilities.notes.create(input.title, input.content);
    return { saved: true, documentId: note.documentId, title: note.title };
  },
  summarizeInput: (input) => `"${truncate(input.title, 80)}"`,
  summarizeOutput: (output) =>
    output.dryRun ? 'dry run: not saved' : `saved "${String(output.title)}"`,
  approvalPreview: (input) => ({
    title: `Add a note to the knowledge base: "${truncate(input.title, 60)}"`,
    summary:
      'Notes become searchable project knowledge that future answers can cite, so they are reviewed first.',
    payload: { title: input.title, content: input.content },
  }),
};

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

export const BUILTIN_TOOLS: AnyAgentTool[] = [
  knowledgeSearch,
  documentLookup,
  projectMetadata,
  projectQuery,
  calculator,
  httpRequest,
  createKnowledgeNote,
];

export class ToolRegistry {
  private readonly tools = new Map<string, AnyAgentTool>();

  constructor(tools: AnyAgentTool[] = BUILTIN_TOOLS) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name);
  }

  all(): AnyAgentTool[] {
    return [...this.tools.values()];
  }

  /** JSON Schema for the model: derived from the same Zod schema that validates the call. */
  definitionFor(tool: AnyAgentTool): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  } {
    const schema = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, inputSchema: schema };
  }

  describe(): ToolDescriptorDto[] {
    return this.all().map((tool) => ({
      name: tool.name as ToolName,
      title: tool.title,
      description: tool.description,
      effect: tool.name === 'http_request' ? 'external_read' : tool.effectFor({} as never),
      capabilities: tool.capabilities,
      risk: tool.risk,
    }));
  }
}
