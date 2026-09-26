import type { Database } from '../platform/database/client';
import type { BackgroundJobs } from '../shared-kernel/jobs';
import type { Clock, TransactionRunner } from '../shared-kernel/ports';
import { PROMPT_VERSION } from '../modules/agents';
import type { AuditLog } from '../modules/audit';
import {
  ChatCompletionHandler,
  ConversationUseCases,
  DrizzleConversationRepository,
  DrizzleMessageRepository,
} from '../modules/conversations';
import {
  DrizzleCaseRepository,
  DrizzleDatasetRepository,
  DrizzleEvalRunRepository,
  DrizzleResultRepository,
  EvaluationUseCases,
  type AgentRunner,
  type RunObservation,
} from '../modules/evaluations';
import type { ProjectAccess } from '../modules/projects';
import type { AgentsModule } from './agents-wiring';
import type { AiProviders } from './ai-providers';
import type { AppConfig } from './config';

/**
 * Channels start agent runs and consume their results. They depend on the agents module;
 * the agents module never depends on them (it calls back through RunCompletionHandler).
 */
export function buildChannels(deps: {
  config: AppConfig;
  db: Database;
  tx: TransactionRunner;
  clock: Clock;
  jobs: BackgroundJobs;
  audit: AuditLog;
  projectAccess: ProjectAccess;
  agents: AgentsModule;
  ai: AiProviders;
}) {
  const { config, db, tx, clock, jobs, audit, projectAccess, agents, ai } = deps;
  const agentRepository = agents.repositories.agents;

  // --- chat -------------------------------------------------------------------------------
  const conversationRepository = new DrizzleConversationRepository(db);
  const messageRepository = new DrizzleMessageRepository(db);
  const conversations = new ConversationUseCases({
    conversations: conversationRepository,
    messages: messageRepository,
    agents: {
      findForProject: async (projectId, agentId) => {
        const agent = agentId
          ? await agentRepository.findById(agentId)
          : await agentRepository.findDefault(projectId);
        return agent && agent.projectId === projectId && !agent.archivedAt
          ? { id: agent.id, name: agent.name }
          : null;
      },
    },
    runs: agents.runs,
    activeRuns: (ids) => agents.repositories.runs.activeForTrigger('chat', ids),
    projectAccess,
    tx,
    clock,
  });
  agents.completionHandlers.chat = new ChatCompletionHandler({
    conversations: conversationRepository,
    messages: messageRepository,
    clock,
  });

  // --- evaluations ------------------------------------------------------------------------
  const runner: AgentRunner = {
    describeAgent: async (agentId) => {
      const agent = await agentRepository.findById(agentId);
      if (!agent || agent.archivedAt) return null;
      return {
        id: agent.id,
        name: agent.name,
        projectId: agent.projectId,
        versionId: agent.currentVersion.id,
        version: agent.currentVersion.version,
        model: ai.llm.modelFor(agent.currentVersion.modelProfile),
        provider: ai.llm.name,
      };
    },
    run: async ({ actor, projectId, agentId, evaluationRunId, input }) => {
      const run = await agents.runs.startRun({
        actor,
        projectId,
        agentId,
        trigger: 'evaluation',
        triggerRefId: evaluationRunId,
        input,
        history: [],
        enqueue: false,
      });
      // Evaluation runs execute inline in the evaluation job, one case after another.
      await agents.orchestrator.execute(run.id, { attempt: 1, maxAttempts: 1 });
      const detail = await agents.runs.get(actor, run.id);
      const observation: RunObservation = {
        runId: run.id,
        status: detail.status,
        text: detail.output?.text ?? '',
        citedDocuments: [...new Set((detail.output?.citations ?? []).map((c) => c.documentTitle))],
        toolsCalled: [
          ...new Set(
            detail.toolCalls
              .filter((c) => ['succeeded', 'failed', 'timed_out', 'denied'].includes(c.status))
              .map((c) => c.toolName),
          ),
        ],
        approvalRequested: detail.toolCalls.some(
          (c) =>
            c.approvalId !== null ||
            (c.output as { approvalRequired?: boolean } | null)?.approvalRequired === true,
        ),
        refused: detail.intent === 'unsafe' || detail.intent === 'out_of_scope',
        structuredValid:
          detail.output?.validation?.checks.find((c) => c.name === 'output_schema')?.passed ?? null,
        durationMs: detail.durationMs,
        errorCode: detail.errorCode,
        errorMessage: detail.error?.message ?? null,
      };
      return observation;
    },
  };
  const evaluations = new EvaluationUseCases({
    datasets: new DrizzleDatasetRepository(db),
    cases: new DrizzleCaseRepository(db),
    runs: new DrizzleEvalRunRepository(db),
    results: new DrizzleResultRepository(db),
    runner,
    projectAccess,
    jobs,
    audit,
    tx,
    clock,
    promptVersion: PROMPT_VERSION,
    gitSha: config.gitSha,
  });

  return { conversations, evaluations };
}
