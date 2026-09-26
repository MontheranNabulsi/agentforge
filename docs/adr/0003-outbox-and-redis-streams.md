# ADR 0003: Transactional outbox for jobs, Redis Streams for live events

**Status:** accepted

**Context.** Enqueuing a job directly from a request handler either loses jobs (enqueue after
commit, then crash) or runs jobs for data that was rolled back (enqueue before commit).
Browsers need live run progress that survives reconnects and works across instances.

**Decision.** Background work is written as an outbox row in the same transaction as the data;
a relay (LISTEN/NOTIFY + polling, `SKIP LOCKED`) moves rows into BullMQ with deterministic job
ids. Job handlers are idempotent (conditional status transitions, claims, tool idempotency
keys). Run events go to one Redis Stream per run; SSE uses stream ids as event ids so
`Last-Event-ID` resumes exactly; the database remains the record.

**Consequences.** At-least-once delivery everywhere, made safe by idempotent handlers. Readers
poll streams on the shared Redis connection (no connection per browser tab), trading a little
latency for predictable connection counts on small Redis plans.
