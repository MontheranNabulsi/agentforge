# ADR 0004: A deterministic demo model and hashing embeddings

**Status:** accepted

**Context.** The product must run, be demoed and be tested without paid API keys, and tests
must be reproducible.

**Decision.** `HeuristicFakeLlm` implements the same `LlmProvider` port as the Anthropic
adapter: keyword intent routing, deterministic tool selection, extractive answers with real
citations, JSON synthesis for structured-output agents. `HashingEmbeddingProvider` produces
feature-hashed vectors. Tests use `ScriptedFakeLlm` to script exact model behaviour. The UI
labels demo output clearly.

**Consequences.** CI and the public demo cost nothing and never flake on a provider. The demo
model is not intelligent; evaluation results with it measure orchestration, not model quality.
