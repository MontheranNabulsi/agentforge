# ADR 0001: A modular monolith with enforced boundaries

**Status:** accepted

**Context.** The product has clear sub-domains (identity, tenancy, knowledge, agents, channels,
evaluations) but one team and one deployment target, including a free single instance.

**Decision.** One deployable (`apps/server`) with modules that own their tables and expose an
`index.ts`. Layers inside each module (domain → application → infrastructure/presentation).
Boundaries are checked in CI with dependency-cruiser rather than trusted to convention.
Several entry points (api, worker, all-in-one, cli) share the same composition root.

**Consequences.** Transactions can span modules (e.g. a chat message and its run commit
together) without distributed coordination. Extracting a module later means replacing its
`index.ts` with a client; the boundary rules keep that possible.
