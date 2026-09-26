import type { ToolGrant } from '@agentforge/contracts';
import type { HttpGateway, KnowledgeGateway, ProjectDataGateway } from '../ports';
import type { AnyAgentTool, ToolCapabilities } from './agent-tool';

export class CapabilityDenied extends Error {
  readonly code = 'CAPABILITY_DENIED';
  constructor(capability: string) {
    super(`This agent was not granted the "${capability}" capability`);
    this.name = 'CapabilityDenied';
  }
}

const denied = (capability: string) => () => Promise.reject(new CapabilityDenied(capability));

/**
 * Builds the capability object for one run: bound to the run's project, and containing only
 * what the granted tools declared they need. A tool that was not granted cannot reach, say,
 * notes.create, even if a bug routed a call to it: the function it would call throws.
 */
export function buildToolCapabilities(
  gateways: { knowledge: KnowledgeGateway; projectData: ProjectDataGateway; http: HttpGateway },
  scope: {
    organizationId: string;
    projectId: string;
    runId: string;
    agent: { id: string; name: string };
    onBehalfOfUserId: string;
    grants: ReadonlyMap<string, ToolGrant>;
    tools: AnyAgentTool[];
  },
): ToolCapabilities {
  const granted = new Set(
    scope.tools.filter((tool) => scope.grants.has(tool.name)).flatMap((tool) => tool.capabilities),
  );
  const httpGrant = scope.grants.get('http_request');
  let noteCounter = 0;

  return {
    knowledge: {
      search: granted.has('knowledge:read')
        ? (query, limit) => gateways.knowledge.retrieve(scope.projectId, query, limit)
        : denied('knowledge:read'),
      lookup: granted.has('knowledge:read')
        ? (titleOrId) => gateways.knowledge.lookup(scope.projectId, titleOrId)
        : denied('knowledge:read'),
    },
    project: {
      metadata: granted.has('project:read')
        ? () => gateways.projectData.metadata(scope.projectId)
        : denied('project:read'),
      query: granted.has('project:read')
        ? (query) => gateways.projectData.query(scope.projectId, query)
        : denied('project:read'),
    },
    http: {
      request:
        granted.has('http:get') && httpGrant
          ? (req) =>
              gateways.http.request(
                req,
                {
                  allowedHosts: httpGrant.allowedHosts ?? [],
                  allowWrite: httpGrant.allowWrite === true,
                },
                AbortSignal.timeout(20_000),
              )
          : denied('http:get'),
    },
    notes: {
      create: granted.has('knowledge:write')
        ? (title, content) => {
            noteCounter += 1;
            return gateways.knowledge.createNote({
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              title,
              content,
              agent: scope.agent,
              onBehalfOfUserId: scope.onBehalfOfUserId,
              runId: scope.runId,
              idempotencyKey: `${scope.runId}:note:${noteCounter}`,
            });
          }
        : denied('knowledge:write'),
    },
  };
}
