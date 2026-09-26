import {
  AgentDto,
  AgentVersionDto,
  ApprovalDto,
  ApprovalListQuery,
  CreateAgentInput,
  DecideApprovalInput,
  Id,
  pageOf,
  RunDetailDto,
  RunListQuery,
  RunSummaryDto,
  ToolDescriptorDto,
  UpdateAgentInput,
  type RunEvent,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import { isTerminal } from '../../domain/run-rules';
import {
  agentEtag,
  toAgentDto,
  toAgentVersionDto,
  type AgentUseCases,
} from '../../application/agent-use-cases';
import { toApprovalDto, type ApprovalUseCases } from '../../application/approval-use-cases';
import type { RunEventReader } from '../../application/ports';
import { toRunSummaryDto, type RunUseCases } from '../../application/run-use-cases';

const ProjectParams = z.object({ projectId: Id });
const AgentParams = z.object({ agentId: Id });
const RunParams = z.object({ runId: Id });
const ApprovalParams = z.object({ approvalId: Id });
const OrgParams = z.object({ orgId: Id });

export function agentRoutes(deps: {
  agents: AgentUseCases;
  runs: RunUseCases;
  approvals: ApprovalUseCases;
  events: RunEventReader;
}) {
  const { agents, runs, approvals, events } = deps;
  const named = (request: Parameters<typeof requireActor>[0]) => ({
    ...requireActor(request),
    name: request.auth!.user.name,
  });

  return async (api: App) => {
    // ---- agents ------------------------------------------------------------------------
    api.get(
      '/tools',
      {
        schema: {
          tags: ['agents'],
          summary: 'Built-in tools an agent can be granted',
          response: { 200: z.array(ToolDescriptorDto) },
        },
      },
      async (request) => {
        requireActor(request);
        return agents.tools();
      },
    );

    api.get(
      '/projects/:projectId/agents',
      { schema: { tags: ['agents'], params: ProjectParams, response: { 200: z.array(AgentDto) } } },
      async (request) =>
        (await agents.list(requireActor(request), request.params.projectId)).map(toAgentDto),
    );

    api.post(
      '/projects/:projectId/agents',
      {
        schema: {
          tags: ['agents'],
          params: ProjectParams,
          body: CreateAgentInput,
          response: { 201: AgentDto },
        },
      },
      async (request, reply) => {
        const agent = await agents.create(named(request), request.params.projectId, request.body);
        return reply.status(201).header('etag', agentEtag(agent)).send(toAgentDto(agent));
      },
    );

    api.get(
      '/agents/:agentId',
      { schema: { tags: ['agents'], params: AgentParams, response: { 200: AgentDto } } },
      async (request, reply) => {
        const agent = await agents.get(requireActor(request), request.params.agentId);
        return reply.header('etag', agentEtag(agent)).send(toAgentDto(agent));
      },
    );

    api.patch(
      '/agents/:agentId',
      {
        schema: {
          tags: ['agents'],
          summary:
            'Edit an agent. Configuration changes create a new immutable version. Send If-Match with the ETag you read.',
          params: AgentParams,
          body: UpdateAgentInput,
          response: { 200: AgentDto },
        },
      },
      async (request, reply) => {
        const ifMatch = request.headers['if-match'] ?? null;
        const agent = await agents.update(
          named(request),
          request.params.agentId,
          request.body,
          Array.isArray(ifMatch) ? ifMatch[0]! : ifMatch,
        );
        return reply.header('etag', agentEtag(agent)).send(toAgentDto(agent));
      },
    );

    api.get(
      '/agents/:agentId/versions',
      {
        schema: {
          tags: ['agents'],
          params: AgentParams,
          response: { 200: z.array(AgentVersionDto) },
        },
      },
      async (request) =>
        (await agents.versions(requireActor(request), request.params.agentId)).map(
          toAgentVersionDto,
        ),
    );

    // ---- runs --------------------------------------------------------------------------
    api.get(
      '/projects/:projectId/runs',
      {
        schema: {
          tags: ['runs'],
          params: ProjectParams,
          querystring: RunListQuery,
          response: { 200: pageOf(RunSummaryDto) },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await runs.list(requireActor(request), request.params.projectId, {
          limit: q.limit,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(q.agentId ? { agentId: q.agentId } : {}),
          ...(q.trigger ? { trigger: q.trigger } : {}),
        });
        return { data: page.data.map(toRunSummaryDto), page: page.page };
      },
    );

    api.get(
      '/runs/:runId',
      {
        schema: {
          tags: ['runs'],
          summary: 'Run inspector: steps, tool calls, tokens, errors',
          params: RunParams,
          response: { 200: RunDetailDto },
        },
      },
      async (request) => runs.get(requireActor(request), request.params.runId),
    );

    api.post(
      '/runs/:runId/cancel',
      { schema: { tags: ['runs'], params: RunParams, response: { 200: RunSummaryDto } } },
      async (request) => toRunSummaryDto(await runs.cancel(named(request), request.params.runId)),
    );

    /**
     * Server-sent events. The stream id of each event is sent as the SSE id, so EventSource's
     * automatic reconnect (Last-Event-ID) resumes without gaps or duplicates.
     */
    api.get(
      '/runs/:runId/events',
      {
        schema: {
          tags: ['runs'],
          summary: 'Live run events (text/event-stream)',
          params: RunParams,
          querystring: z.object({ after: z.string().max(40).optional() }),
        },
      },
      async (request, reply) => {
        const run = await runs.authorize(requireActor(request), request.params.runId);
        const header = request.headers['last-event-id'];
        let cursor: string | null =
          (Array.isArray(header) ? header[0] : header) ?? request.query.after ?? null;
        if (cursor && !/^\d+-\d+$/.test(cursor)) cursor = null;

        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-request-id': String(request.id),
        });
        res.write('retry: 2000\n\n');
        let closed = false;
        request.raw.on('close', () => {
          closed = true;
        });

        const send = (id: string | null, event: RunEvent) => {
          res.write(
            `${id ? `id: ${id}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        };
        const startedAt = Date.now();
        let terminalSeen = false;
        try {
          while (!closed && !terminalSeen && Date.now() - startedAt < 10 * 60_000) {
            const batch = await events.read(run.id, cursor, 12_000);
            for (const { id, event } of batch) {
              send(id, event);
              cursor = id;
              if (event.type === 'run.completed' || event.type === 'run.failed')
                terminalSeen = true;
            }
            if (batch.length === 0 && !closed) {
              res.write(': keep-alive\n\n');
              // The stream may have expired, or the run finished before we subscribed.
              const latest = await runs.authorize(requireActor(request), run.id);
              if (isTerminal(latest.status)) {
                const at = (latest.completedAt ?? new Date()).toISOString();
                send(
                  null,
                  latest.status === 'completed'
                    ? { type: 'run.completed', runId: latest.id, messageId: null, at }
                    : {
                        type: 'run.failed',
                        runId: latest.id,
                        status: latest.status,
                        errorCode: latest.error?.code ?? 'INTERNAL',
                        message: latest.error?.message ?? 'The run failed',
                        at,
                      },
                );
                terminalSeen = true;
              }
            }
          }
        } catch (error) {
          request.log.warn({ err: error }, 'run event stream failed');
        } finally {
          res.end();
        }
      },
    );

    // ---- approvals ---------------------------------------------------------------------
    api.get(
      '/orgs/:orgId/approvals',
      {
        schema: {
          tags: ['approvals'],
          params: OrgParams,
          querystring: ApprovalListQuery,
          response: { 200: pageOf(ApprovalDto) },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await approvals.list(requireActor(request), request.params.orgId, {
          limit: q.limit,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
        });
        return { data: page.data.map(toApprovalDto), page: page.page };
      },
    );

    api.get(
      '/approvals/:approvalId',
      { schema: { tags: ['approvals'], params: ApprovalParams, response: { 200: ApprovalDto } } },
      async (request) =>
        toApprovalDto(await approvals.get(requireActor(request), request.params.approvalId)),
    );

    api.post(
      '/approvals/:approvalId/decision',
      {
        schema: {
          tags: ['approvals'],
          summary: 'Approve or reject a pending agent action',
          params: ApprovalParams,
          body: DecideApprovalInput,
          response: { 200: ApprovalDto },
        },
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      },
      async (request) =>
        toApprovalDto(
          await approvals.decide(named(request), request.params.approvalId, request.body),
        ),
    );
  };
}
