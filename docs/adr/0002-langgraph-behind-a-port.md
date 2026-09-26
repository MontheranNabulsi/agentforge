# ADR 0002: LangGraph.js behind an application port

**Status:** accepted

**Context.** Runs need checkpointing after every step, pause/resume for human approval, and
crash recovery. LangGraph provides these (`interrupt`, `Command({ resume })`, `PostgresSaver`),
but tying application code to a fast-moving framework makes it hard to test and replace.

**Decision.** The run's behaviour lives in `RunNodes` (plain application code: state in, state
changes out). The application defines an `AgentWorkflow` port; the LangGraph adapter wires the
nodes into a `StateGraph` and is the only code allowed to import `@langchain/*` (enforced).
Checkpoints use Postgres (thread id = run id) with synchronous durability; they are deleted
when a run ends.

**Consequences.** Node logic is testable without LangGraph; replacing the engine touches one
directory. Node names must differ from state keys (hence `make_plan`), a LangGraph constraint.
