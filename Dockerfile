# syntax=docker/dockerfile:1
#
# All-in-one image: API + background worker + the Next.js web app in one Node process,
# which is what a single free instance (Render, Fly, Railway…) can run. For larger setups
# run the same image three times with different commands (see docs/deployment.md).

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.6.0 --no-fund --no-audit
WORKDIR /app

# ---- dependencies (cached until a manifest or the lockfile changes) ------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @agentforge/web build \
 && pnpm --filter @agentforge/server build \
 && rm -rf apps/web/.next/cache

# ---- production dependencies only -------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SERVE_WEB=true \
    WEB_DIR=/app/apps/web \
    MIGRATIONS_DIR=/app/apps/server/dist/migrations \
    PORT=10000 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/public apps/web/public
COPY --from=build /app/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build /app/packages/contracts/src packages/contracts/src
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/all-in-one.js"]
