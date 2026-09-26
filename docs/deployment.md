# Deployment

## Free single instance: Render + Supabase

One Docker web service runs the API, the workers and the web app (`all-in-one`). Postgres comes
from Supabase (pgvector is available), Redis from Render Key Value.

1. **Database (Supabase).** Create a project, then a login role for the app with `CREATE` on the
   `public` schema and the database (for the `langgraph` schema). Use the **session pooler**
   connection string (port 5432; the transaction pooler breaks `LISTEN/NOTIFY` and prepared
   statements).
2. **Redis (Render Key Value).** Create a free instance with the `noeviction` policy (queues must
   not be evicted). Use the internal connection string.
3. **Web service (Render).** New → Web Service → this repository → runtime Docker, region close
   to the database. Environment:

| Variable            | Value                                           |
| ------------------- | ----------------------------------------------- |
| `DATABASE_URL`      | Supabase session-pooler URL                     |
| `DATABASE_SSL`      | `require`                                       |
| `DATABASE_POOL_MAX` | `8`                                             |
| `REDIS_URL`         | Render Key Value internal URL                   |
| `BLOB_STORAGE`      | `postgres` (the free disk is ephemeral)         |
| `MIGRATE_ON_START`  | `true`                                          |
| `SEED_ON_START`     | `true` for the demo workspace                   |
| `COOKIE_SECURE`     | `true`                                          |
| `TRUST_PROXY_HOPS`  | `1`                                             |
| `SELF_PING`         | `true` to keep the free instance awake          |
| `LLM_PROVIDER`      | `fake`, or `anthropic` with `ANTHROPIC_API_KEY` |

`APP_URL` defaults to Render's `RENDER_EXTERNAL_URL`; set it if you use a custom domain.

The first deploy builds the image (≈5 minutes), migrates, starts, and seeds the demo workspace
in the background. Health: `GET /health/ready` checks Postgres and Redis.

**Free-tier notes.** Render free instances have 512 MB of memory (the all-in-one process uses
about 320 MB idle), sleep after 15 minutes without traffic (`SELF_PING` or the keep-alive
workflow prevents that), and restart on each deploy. Supabase free projects pause after a week
of inactivity.

## Growing past one instance

Run the same image with different commands:

| Service              | Command                                              |
| -------------------- | ---------------------------------------------------- |
| API (N instances)    | `node apps/server/dist/api.js` with `SERVE_WEB=true` |
| Worker (M instances) | `node apps/server/dist/worker.js`                    |
| Release step         | `node apps/server/dist/cli.js migrate`               |

Set `MIGRATE_ON_START=false` and `SEED_ON_START=false` on the long-running services. Everything
that must be shared (sessions, queues, run event streams, rate limits, idempotency keys, graph
checkpoints) already lives in Postgres or Redis, so instances are interchangeable.

## Using Claude

Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Models default to `claude-sonnet-5`
(agent turns) and `claude-haiku-4-5-20251001` (classification); override with
`ANTHROPIC_MODEL` and `ANTHROPIC_MODEL_FAST`. `DAILY_TOKEN_BUDGET_PER_ORG` caps spend per
organization per day.
