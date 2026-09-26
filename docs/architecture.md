# Architecture

## Processes

One codebase, several entry points (`apps/server/src/main/`):

| Entry point     | What it runs                                    | When to use it                                  |
| --------------- | ----------------------------------------------- | ----------------------------------------------- |
| `all-in-one.ts` | API + workers + (optionally) the Next.js app    | local development, free single-instance hosting |
| `api.ts`        | HTTP API only                                   | scale horizontally behind a load balancer       |
| `worker.ts`     | outbox relay, BullMQ workers, maintenance sweep | scale by queue concurrency                      |
| `cli.ts`        | `migrate`, `seed`, `evals`, `openapi`           | release steps, CI                               |

`main/container.ts` is the composition root: the only file that knows every concrete class.
Everything else receives dependencies through constructors.

## Modules and layers

```
apps/server/src/
  shared-kernel/   ids, errors, pagination, ports (Clock, TransactionRunner), AI ports, job topics
  platform/        database, HTTP server, queues/outbox, logging, security, outbound HTTP, AI adapters
  db/schema/       Drizzle schema + SQL migrations
  modules/
    identity        users, credentials, sessions, password reset
    organizations   tenants, memberships, the RBAC matrix
    projects        projects, ProjectAccess (the tenant check every module starts with)
    audit           append-only audit log
    knowledge       documents, ingestion pipeline, hybrid retrieval
    agents          agent versions, tools, runs, approvals, the run graph
    conversations   the chat channel
    evaluations     datasets, evaluators, evaluation runs
    insights        read-only dashboards and the project_query backend
```

Inside a module: `domain/` (pure rules, no I/O, unit-tested as tables) → `application/` (use
cases that depend on ports) → `infrastructure/` (Drizzle, Redis, LangGraph adapters) and
`presentation/` (HTTP routes, job handlers). `.dependency-cruiser.cjs` enforces:

- domain imports only its own domain and the shared kernel;
- application never imports infrastructure, presentation, the platform layer, the schema,
  drivers or SDKs;
- modules reach each other only through `index.ts`;
- only the LangGraph adapter imports `@langchain/*`;
- no cycles.

## A chat message, end to end

1. `POST /api/v1/conversations/:id/messages` (optionally with `Idempotency-Key`).
2. In **one transaction**: the user message is inserted, a `queued` run is created (pinned to
   the agent's current version), `run.started` is audited, and an `agent-run.execute` row is
   written to the outbox. A partial unique index allows one active run per conversation, so a
   second message while the agent is busy is a `409 RUN_IN_PROGRESS` and nothing is saved.
3. The outbox relay (woken by `NOTIFY`, with polling as a safety net) moves the row into
   BullMQ with the run id as job id (duplicates are no-ops).
4. The worker's `AgentRunOrchestrator.execute` moves the run `queued → running` with a
   conditional update and invokes the graph.
5. Each node records a step, publishes events to a Redis Stream (`run-events:<runId>`), and the
   browser receives them over SSE (`GET /runs/:id/events`), resuming with `Last-Event-ID`.
6. A write tool creates an approval request and the graph pauses with `interrupt()`; the run
   becomes `awaiting_approval`. Deciding writes the decision and an `agent-run.resume` outbox
   row in one transaction; the resume job continues the graph from its checkpoint.
7. On completion, the run's terminal state and the assistant message (written by the chat
   channel's `RunCompletionHandler`) commit in one transaction.

## The run graph

```
START → classify ─┬─ refuse ────────────────────────────────┐
                  ├─ make_plan → retrieve? ─┐               │
                  ├─ retrieve ──────────────┤               │
                  └─────────────────────────┴→ act ⇄ tools ⇄ await_approval
                                               │
                                               └→ validate ⇄ act (one repair for JSON output)
                                                   └→ finalize ←──────────┘ → END
```

- **classify** (fast model, structured output) → intent `question | task | chitchat |
out_of_scope | unsafe`, plus a deterministic injection check on the user's own request.
- **make_plan** for tasks; **retrieve** runs hybrid search with the agent's `topK`.
- **act** streams one model turn with only the granted tools offered.
- **tools** runs each requested call through `ToolExecutionService` (see below).
- **validate** strips unknown citations, checks grounding, redacts secrets, validates JSON
  output against the agent's schema (one repair turn), and flags truncated answers.
- Budgets (model steps, tool calls, tokens, wall-clock deadline) are checked before every model
  turn; cancellation is checked between nodes.

Checkpoints are written synchronously after every node to the `langgraph` schema
(`PostgresSaver`, thread id = run id) and deleted once the run is terminal.

## Tool execution

For every call the model requests: idempotency (`runId:turn:index`; finished calls are replayed,
never re-executed; a write interrupted mid-flight is not retried), allowlist (granted to this
agent version), Zod input validation, the triggering user's permission, the approval policy
(`domain/approval-policy.ts`), then execution with a timeout. Tools receive a
`ToolCapabilities` object bound to the run's project containing only the capabilities their
grants require; everything else throws `CapabilityDenied`.

## Knowledge pipeline

Upload → content-based type detection → blob storage (filesystem or Postgres) → document row +
outbox job → worker claims the document (compare-and-set, so duplicate jobs skip) → text
extraction (unpdf for PDF) → heading-aware chunking with overlap → injection-marker scan →
embeddings (batch) → `chunk_embeddings` (pgvector, HNSW cosine) and a generated `tsvector`
column (GIN). Retrieval runs vector and keyword search in parallel and fuses them with RRF
(k = 60). Query embeddings are cached in Redis.

## Data model highlights

- UUIDv7 primary keys generated by the application (time-ordered, index-friendly).
- Composite tenant foreign keys `(project_id, organization_id)` so a row can never point at a
  project of another organization.
- Partial unique indexes: one default agent per project, one active run per conversation.
- Agent versions are immutable (a trigger rejects updates); runs reference the exact version.
- The audit table rejects `UPDATE` and `DELETE` at the database level.
- Keyset pagination everywhere (`(created_at, id)` cursors).
