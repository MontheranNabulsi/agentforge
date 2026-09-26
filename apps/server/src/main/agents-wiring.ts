import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Database } from '../platform/database/client';
import type { ErrorReporter } from '../platform/observability/error-reporter';
import type { Logger } from '../platform/observability/logger';
import { SafeHttpClient } from '../platform/outbound-http/safe-http-client';
import type { BackgroundJobs } from '../shared-kernel/jobs';
import type { Clock, TransactionRunner } from '../shared-kernel/ports';
import {
  AgentRunOrchestrator,
  AgentUseCases,
  AjvOutputValidator,
  ApprovalUseCases,
  createMemoryCheckpointer,
  createPostgresCheckpointer,
  DrizzleAgentRepository,
  DrizzleApprovalRepository,
  DrizzleRunRepository,
  DrizzleStepRepository,
  DrizzleToolCallRepository,
  LangGraphAgentWorkflow,
  RedisRunEvents,
  RunContextFactory,
  RunMaintenance,
  RunUseCases,
  ToolExecutionService,
  ToolRegistry,
  type HttpGateway,
  type KnowledgeGateway,
  type MemberPermissions,
  type RunCompletionHandlers,
} from '../modules/agents';
import type { AuditLog } from '../modules/audit';
import { SqlProjectData } from '../modules/insights';
import { can, type OrganizationAccess, type Permission } from '../modules/organizations';
import type { ProjectAccess } from '../modules/projects';
import type { AiProviders } from './ai-providers';
import type { AppConfig } from './config';
import type { KnowledgeModule } from './knowledge-wiring';

export function buildAgentsModule(deps: {
  config: AppConfig;
  db: Database;
  pool: pg.Pool;
  tx: TransactionRunner;
  clock: Clock;
  jobs: BackgroundJobs;
  audit: AuditLog;
  projectAccess: ProjectAccess;
  organizationAccess: OrganizationAccess;
  knowledge: KnowledgeModule;
  redis: Redis;
  ai: AiProviders;
  logger: Logger;
  errors: ErrorReporter;
  checkpointer?: 'postgres' | 'memory';
  httpClient?: SafeHttpClient;
}) {
  const {
    config,
    db,
    tx,
    clock,
    jobs,
    audit,
    projectAccess,
    organizationAccess,
    knowledge,
    redis,
    ai,
    logger,
  } = deps;

  const agents = new DrizzleAgentRepository(db);
  const runs = new DrizzleRunRepository(db);
  const steps = new DrizzleStepRepository(db);
  const toolCalls = new DrizzleToolCallRepository(db);
  const approvals = new DrizzleApprovalRepository(db);
  const registry = new ToolRegistry();
  const validator = new AjvOutputValidator();
  const events = new RedisRunEvents(redis, { prefix: `${config.redis.queuePrefix}:run-events:` });

  // --- gateways: what agents may reach, implemented by the modules that own the data ------
  const knowledgeGateway: KnowledgeGateway = {
    retrieve: async (projectId, query, limit) =>
      (await knowledge.useCases.retrieve(projectId, query, limit)).map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        headingPath: c.headingPath,
        pageNumber: c.pageNumber,
        content: c.content,
        score: c.score,
      })),
    lookup: async (projectId, titleOrId) => {
      const found = await knowledge.useCases.lookupDocument(projectId, titleOrId);
      if (!found) return null;
      return {
        id: found.document.id,
        title: found.document.title,
        status: found.document.status,
        chunkCount: found.document.chunkCount,
        preview: found.preview.map((chunk) => ({
          chunkId: chunk.id,
          documentId: found.document.id,
          documentTitle: found.document.title,
          headingPath: chunk.headingPath,
          pageNumber: chunk.pageNumber,
          content: chunk.content,
        })),
      };
    },
    createNote: async (params) => {
      const document = await knowledge.useCases.createNote({
        organizationId: params.organizationId,
        projectId: params.projectId,
        title: params.title,
        content: params.content,
        actor: {
          type: 'agent',
          id: params.agent.id,
          name: params.agent.name,
          onBehalfOfUserId: params.onBehalfOfUserId,
        },
        createdByUserId: params.onBehalfOfUserId,
        runId: params.runId,
        idempotencyKey: params.idempotencyKey,
      });
      return { documentId: document.id, title: document.title };
    },
  };
  const httpClient = deps.httpClient ?? new SafeHttpClient();
  const httpGateway: HttpGateway = {
    request: (req, policy, signal) => httpClient.request(req, policy, signal),
  };
  const projectData = new SqlProjectData(db);
  const permissions: MemberPermissions = {
    roleOf: (userId, organizationId) =>
      organizationAccess.roleOf({ userId, sessionId: null }, organizationId),
    allows: (role, permission) => can(role, permission as Permission),
  };

  // --- the run engine -------------------------------------------------------------------
  const toolExecution = new ToolExecutionService({
    registry,
    toolCalls,
    approvals,
    permissions,
    audit,
    tx,
    clock,
  });
  const checkpointer =
    deps.checkpointer === 'memory'
      ? createMemoryCheckpointer()
      : createPostgresCheckpointer(deps.pool);
  const workflow = new LangGraphAgentWorkflow({
    checkpointer,
    nodeDeps: {
      llm: ai.llm,
      registry,
      toolExecution,
      knowledge: knowledgeGateway,
      runs,
      validator,
      clock,
    },
  });
  const contexts = new RunContextFactory({
    agents,
    projects: projectAccess,
    runs,
    steps,
    registry,
    events,
    gateways: { knowledge: knowledgeGateway, projectData, http: httpGateway },
    clock,
    onEventError: (error) => logger.warn({ err: error }, 'run event publish failed'),
  });
  /** Filled in by the channels (conversations, evaluations) during composition. */
  const completionHandlers: RunCompletionHandlers = {};
  const orchestrator = new AgentRunOrchestrator({
    agents,
    runs,
    steps,
    toolCalls,
    approvals,
    workflow,
    contexts,
    completionHandlers,
    events,
    audit,
    tx,
    clock,
    logger,
  });

  // --- use cases ------------------------------------------------------------------------
  const agentUseCases = new AgentUseCases({
    agents,
    projectAccess,
    registry,
    validator,
    audit,
    tx,
    clock,
  });
  const runUseCases = new RunUseCases({
    agents,
    runs,
    steps,
    toolCalls,
    projectAccess,
    orchestrator,
    llm: ai.llm,
    jobs,
    audit,
    tx,
    clock,
    limits: config.limits,
  });
  const approvalUseCases = new ApprovalUseCases({
    approvals,
    toolCalls,
    organizationAccess,
    projectAccess,
    events,
    jobs,
    audit,
    tx,
    clock,
  });
  const maintenance = new RunMaintenance({
    runs,
    approvals: approvalUseCases,
    orchestrator,
    jobs,
    tx,
    clock,
  });

  return {
    repositories: { agents, runs, steps, toolCalls, approvals },
    registry,
    events,
    orchestrator,
    completionHandlers,
    agents: agentUseCases,
    runs: runUseCases,
    approvals: approvalUseCases,
    maintenance,
    onProjectCreated: agentUseCases.onProjectCreated,
    // The Postgres checkpointer shares the application pool, which the database handle closes.
    close: async () => undefined,
  };
}

export type AgentsModule = ReturnType<typeof buildAgentsModule>;
