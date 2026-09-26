import { sql } from 'drizzle-orm';
import { buildHttpServer, type App, type ReadinessReport } from '../platform/http/server';
import { WORK_QUEUES } from '../platform/queue/queues';
import { agentRoutes } from '../modules/agents';
import { conversationRoutes } from '../modules/conversations';
import { evaluationRoutes } from '../modules/evaluations';
import { identityRoutes } from '../modules/identity';
import { insightsRoutes } from '../modules/insights';
import { knowledgeRoutes } from '../modules/knowledge';
import { organizationRoutes } from '../modules/organizations';
import { projectRoutes } from '../modules/projects';
import type { Container } from './container';

const bootedAt = Date.now();

async function timed(
  check: () => Promise<unknown>,
): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  const started = performance.now();
  try {
    await check();
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The HTTP edge: one route module per bounded context, all under /api/v1. */
export async function buildApi(container: Container): Promise<App> {
  const { config, logger, errors, identity, db, redis, queues, ai } = container;

  const readiness = async (): Promise<ReadinessReport> => {
    const [database, cache] = await Promise.all([
      timed(() => db.execute(sql`SELECT 1`)),
      timed(() => redis.ping()),
    ]);
    return { ok: database.ok && cache.ok, checks: { database, redis: cache } };
  };

  const systemStatus = async () => {
    const [database, cache] = await Promise.all([
      timed(() => db.execute(sql`SELECT 1`)),
      timed(() => redis.ping()),
    ]);
    const queueStats = await Promise.all(
      WORK_QUEUES.map(async (name) => {
        try {
          const counts = await queues
            .get(name)
            .getJobCounts('waiting', 'active', 'delayed', 'failed');
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch {
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0 };
        }
      }),
    );
    const deadLetters = await queues
      .get('dead-letter')
      .getJobCounts('waiting', 'completed', 'failed')
      .then((c) => (c.waiting ?? 0) + (c.completed ?? 0) + (c.failed ?? 0))
      .catch(() => 0);
    return {
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
      database: { ok: database.ok, latencyMs: database.latencyMs },
      redis: { ok: cache.ok, latencyMs: cache.latencyMs },
      queues: queueStats,
      deadLetters,
      ai: ai.describe(),
    };
  };

  return buildHttpServer({
    logger,
    version: config.version,
    allowedOrigins: config.http.allowedOrigins,
    trustProxyHops: config.http.trustProxyHops,
    rateLimitRedis: redis,
    errors,
    enableDocs: config.http.enableDocs,
    readiness,
    authenticate: async (token) => {
      const auth = await identity.authenticate(token);
      return auth
        ? {
            user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
            session: auth.session,
          }
        : null;
    },
    registerApiRoutes: async (api) => {
      await api.register(identityRoutes({ identity, cookieSecure: config.http.cookieSecure }));
      await api.register(
        organizationRoutes({
          organizations: container.organizations,
          access: container.organizationAccess,
          auditQueries: container.auditQueries,
        }),
      );
      await api.register(projectRoutes({ projects: container.projects }));
      await api.register(
        knowledgeRoutes({
          knowledge: container.knowledge.useCases,
          embeddingModel: container.knowledge.embeddingModel,
        }),
      );
      await api.register(
        agentRoutes({
          agents: container.agents.agents,
          runs: container.agents.runs,
          approvals: container.agents.approvals,
          events: container.agents.events,
        }),
      );
      await api.register(
        conversationRoutes({
          conversations: container.conversations,
          idempotency: container.idempotency,
        }),
      );
      await api.register(evaluationRoutes({ evaluations: container.evaluations }));
      await api.register(insightsRoutes({ insights: container.insights, systemStatus }));
    },
  });
}
