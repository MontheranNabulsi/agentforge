import type { RunEvent } from '@agentforge/contracts';
import type { Clock } from '../../../shared-kernel/ports';
import { RunStopped } from '../domain/run-rules';
import type {
  AgentRepository,
  HttpGateway,
  KnowledgeGateway,
  ProjectDataGateway,
  ProjectLookup,
  RunEventPublisher,
  RunRecord,
  RunRepository,
  StepRepository,
} from './ports';
import { makeActivityGuard, StepRecorder, type RunContextHandle } from './run-context';
import type { ToolRegistry } from './tools/builtin-tools';
import { buildToolCapabilities } from './tools/tool-capabilities';

export interface RunContextFactoryDeps {
  agents: AgentRepository;
  projects: ProjectLookup;
  runs: RunRepository;
  steps: StepRepository;
  registry: ToolRegistry;
  events: RunEventPublisher;
  gateways: { knowledge: KnowledgeGateway; projectData: ProjectDataGateway; http: HttpGateway };
  clock: Clock;
  onEventError: (error: unknown) => void;
}

/** Assembles a RunContext from the run's pinned agent version (never the agent's latest version). */
export class RunContextFactory {
  constructor(private readonly deps: RunContextFactoryDeps) {}

  async create(run: RunRecord, deadlineAt: Date): Promise<RunContextHandle> {
    const { agents, projects, registry, events, clock, gateways } = this.deps;
    const version = await agents.findVersion(run.agentVersionId);
    if (!version)
      throw new RunStopped('INTERNAL', 'The agent version for this run no longer exists', 'failed');
    const project = await projects.load(run.projectId);
    const grants = new Map(version.tools.map((grant) => [grant.tool as string, grant]));
    const tools = registry.all().filter((tool) => grants.has(tool.name));

    const controller = new AbortController();
    const remaining = Math.max(0, deadlineAt.getTime() - clock.now().getTime());
    const timer = setTimeout(
      () =>
        controller.abort(
          new RunStopped(
            'DEADLINE_EXCEEDED',
            `The run exceeded its ${version.limits.timeoutSeconds}s time limit`,
            'timed_out',
          ),
        ),
      remaining,
    );
    timer.unref?.();

    const emit = async (event: RunEvent) => {
      try {
        await events.publish(run.id, event);
      } catch (error) {
        // Live streaming is best effort: the database remains the record of what happened.
        this.deps.onEventError(error);
      }
    };

    const steps = new StepRecorder(
      { steps: this.deps.steps, clock, emit },
      { id: run.id, organizationId: run.organizationId },
    );
    const capabilities = buildToolCapabilities(gateways, {
      organizationId: run.organizationId,
      projectId: run.projectId,
      runId: run.id,
      agent: { id: run.agentId, name: run.agentName },
      onBehalfOfUserId: run.triggeredBy ?? '',
      grants,
      tools,
    });
    const ensureActive = makeActivityGuard({ runs: this.deps.runs, clock }, run.id, deadlineAt);

    return {
      ctx: {
        run,
        version,
        agentName: run.agentName,
        project,
        dryRun: run.trigger === 'evaluation',
        signal: controller.signal,
        deadlineAt,
        grants,
        tools,
        capabilities,
        steps,
        emit,
        ensureActive,
        recordUsage: (usage) => this.deps.runs.addUsage(run.id, usage),
      },
      dispose: () => clearTimeout(timer),
    };
  }
}
