# Security

This document lists what AgentForge does to reduce risk and — just as important — what it does
not do. Having these controls does not make a deployment secure; review them against your own
threat model.

## Controls

**Identity and sessions**

- Passwords hashed with Argon2id; constant-time dummy verification for unknown emails.
- Sessions are random 256-bit tokens stored hashed; the cookie is `HttpOnly`, `SameSite=Lax`,
  `Secure` in production; sliding idle expiry with an absolute lifetime; changing a password
  revokes other sessions.
- Password reset tokens are single-use, hashed, and expire after 30 minutes; the request endpoint
  answers the same way whether or not the email exists.

**Authorization and tenancy**

- Every use case starts with `OrganizationAccess.require` / `ProjectAccess.require`: non-members
  get `404` (existence is not revealed), members without the permission get `403`.
- The RBAC matrix is one table of data (`organizations/domain/access-rules.ts`), unit-tested row
  by row. Agents act on behalf of the user who triggered the run and never exceed their role.
- Composite foreign keys prevent cross-tenant references at the database level.

**Web**

- CSRF: state-changing requests that carry the session cookie must come from an allowed
  `Origin` (or `Referer`); otherwise `403`.
- Model output and documents are rendered as Markdown without raw HTML; links are restricted to
  `http(s)`, `mailto`, relative and anchor URLs.
- Security headers via Helmet (API) and Next.js config (web); `X-Frame-Options: DENY`.
- Per-user/IP rate limits (Redis-backed) on authentication, uploads, chat and evaluations;
  per-organization caps on concurrent runs and daily tokens.
- Idempotency keys make retried POSTs safe.

**Agents and tools**

- Tools declare capabilities; an agent version is granted specific tools; the capability object
  handed to a tool contains only what its grant needs.
- Tool inputs are validated with Zod before anything runs; unknown tool names are rejected.
- Anything that writes data requires human approval (admins may pre-approve low/medium-risk
  tools per agent; the call is still recorded). High-risk tools always need an admin or owner.
- `project_query` is a fixed menu of parameterised queries; the model never writes SQL.
- Outbound HTTP (`http_request`): https only, per-agent host allowlist, every resolved address
  must be public unicast (loopback, private, link-local/metadata, CGNAT, multicast blocked),
  the connection is pinned to the vetted address (no DNS rebinding), redirects are re-checked,
  no credentials are ever attached, and response size and time are capped. Non-GET methods need
  `allowWrite` on the grant and human approval.
- Budgets bound every run: model steps, tool calls, tokens and wall-clock time.

**Prompt injection**

- Uploaded documents are scanned for instruction-like text and flagged in the UI.
- Retrieved passages and tool results are fenced (`<sources>`, tool results) and the system
  prompt tells the model to treat them as data, never as instructions; source text cannot close
  its own tags.
- Obvious injection attempts in the user's request are refused deterministically, before any
  tool can run; the classifier catches more.
- Citations to sources that were never retrieved are stripped; credential-like strings are
  redacted from answers.

**Audit and operations**

- Append-only audit log (database triggers reject updates and deletes) with the acting user or
  agent and the user it acted for.
- Structured logs with request, job and run correlation ids; secrets are redacted by path.
- Configuration is validated at boot; the process refuses to start with invalid settings.

## Known limitations

- **Prompt injection is not solved.** Pattern-based detection misses rephrased or encoded
  attacks, and a capable model can still be persuaded by retrieved text. The real controls are
  the capability boundary and human approval for writes — keep write tools behind approval.
- An allowlisted host that is itself compromised can return hostile content.
- Evaluations and the demo model are deterministic; they catch regressions in orchestration, not
  model quality. Run the datasets with a real model before trusting a change.
- The demo deployment publishes a shared demo account; anyone can change its data. Do not put
  real information in it.
- Email delivery is off unless `SMTP_URL` is set (reset links are then only logged).
- No SSO, MFA, per-document ACLs or data-retention policies yet; project members can read all
  project conversations.
- Rate limits are per instance of Redis; there is no WAF or bot protection in front of the app.
- Blob storage in Postgres (used on free hosting) is not meant for large files.
