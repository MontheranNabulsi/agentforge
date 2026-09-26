import { z } from 'zod';

const bool = z.stringbool({
  truthy: ['true', '1', 'yes', 'on'],
  falsy: ['false', '0', 'no', 'off', ''],
});
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/**
 * Twelve-factor configuration, validated once at boot. A process with a missing or malformed
 * setting refuses to start and lists every problem, instead of failing later at first use.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('0.1.0'),
  GIT_SHA: z.string().optional(),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** Public URL of the web app: links in emails, CSRF origin allowlist. */
  APP_URL: z.url().default('http://localhost:4000'),
  ALLOWED_ORIGINS: csv.optional(),
  /** Hops of reverse proxies to trust for client IPs (Render/Heroku-style platforms: 1). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  COOKIE_SECURE: bool.default(false),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://agentforge:agentforge@localhost:5432/agentforge'),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().default('agentforge'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('AgentForge <no-reply@agentforge.local>'),

  BLOB_STORAGE: z.enum(['filesystem', 'postgres']).default('filesystem'),
  BLOB_STORAGE_DIR: z.string().default('./storage'),

  LLM_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  EMBEDDING_PROVIDER: z.enum(['hashing', 'openai-compatible']).default('hashing'),
  EMBEDDING_BASE_URL: z.string().default('http://localhost:11434/v1'),
  EMBEDDING_MODEL: z.string().default('mxbai-embed-large'),
  EMBEDDING_API_KEY: z.string().optional(),
  /** Send `dimensions` in embedding requests (OpenAI supports it; many local servers don't). */
  EMBEDDING_SEND_DIMENSIONS: bool.default(false),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(5_000),
  WORKER_CONCURRENCY_AGENT_RUNS: z.coerce.number().int().min(1).default(2),
  WORKER_CONCURRENCY_INGESTION: z.coerce.number().int().min(1).default(1),
  WORKER_CONCURRENCY_EVALUATIONS: z.coerce.number().int().min(1).default(1),
  WORKER_CONCURRENCY_EMAIL: z.coerce.number().int().min(1).default(2),
  MAX_ACTIVE_RUNS_PER_ORG: z.coerce.number().int().min(1).default(5),
  DAILY_TOKEN_BUDGET_PER_ORG: z.coerce.number().int().min(1_000).default(2_000_000),

  ENABLE_API_DOCS: bool.default(true),
  /** all-in-one mode: also serve the built Next.js app from this process. */
  SERVE_WEB: bool.default(false),
  WEB_DIR: z.string().default('../web'),
  /** Free single-instance deployments have no release phase: migrate (and optionally seed) at boot. */
  MIGRATE_ON_START: bool.default(false),
  SEED_ON_START: bool.default(false),
  /**
   * Free hosting tiers sleep after ~15 minutes without inbound traffic. When enabled, the
   * process requests its own public /health/live every 10 minutes through the platform's edge.
   */
  SELF_PING: bool.default(false),
  /** Set automatically by Render; used as APP_URL when APP_URL is not given. */
  RENDER_EXTERNAL_URL: z.url().optional(),
  /** Set automatically by Render; used as GIT_SHA when GIT_SHA is not given. */
  RENDER_GIT_COMMIT: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  version: string;
  gitSha: string | null;
  http: {
    port: number;
    host: string;
    appUrl: string;
    allowedOrigins: string[];
    trustProxyHops: number;
    cookieSecure: boolean;
    enableDocs: boolean;
  };
  database: { url: string; ssl: Env['DATABASE_SSL']; poolMax: number };
  redis: { url: string; queuePrefix: string };
  log: { level: string; pretty: boolean };
  mail: { smtpUrl: string | null; from: string };
  storage: { kind: 'filesystem' | 'postgres'; blobDir: string };
  ai: {
    llmProvider: Env['LLM_PROVIDER'];
    anthropicApiKey: string | null;
    models: { default: string; fast: string };
    embeddingProvider: Env['EMBEDDING_PROVIDER'];
    embeddingBaseUrl: string;
    embeddingModel: string;
    embeddingApiKey: string | null;
    embeddingSendDimensions: boolean;
  };
  worker: {
    outboxPollIntervalMs: number;
    concurrency: { agentRuns: number; ingestion: number; evaluations: number; email: number };
  };
  limits: { maxActiveRunsPerOrg: number; dailyTokenBudgetPerOrg: number };
  web: { serve: boolean; dir: string };
  startup: { migrate: boolean; seed: boolean };
  selfPing: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // On Render the public URL is known only at runtime; use it unless APP_URL is set explicitly.
  const withDefaults =
    source.APP_URL || !source.RENDER_EXTERNAL_URL
      ? source
      : { ...source, APP_URL: source.RENDER_EXTERNAL_URL };
  const parsed = EnvSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  if (e.LLM_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      'Invalid configuration:\n  - ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
    );
  }
  const appOrigin = new URL(e.APP_URL).origin;
  return {
    env: e.NODE_ENV,
    version: e.APP_VERSION,
    gitSha: e.GIT_SHA ?? e.RENDER_GIT_COMMIT ?? null,
    http: {
      port: e.PORT,
      host: e.HOST,
      appUrl: e.APP_URL,
      allowedOrigins: [...new Set([appOrigin, ...(e.ALLOWED_ORIGINS ?? [])])],
      trustProxyHops: e.TRUST_PROXY_HOPS,
      cookieSecure: e.COOKIE_SECURE,
      enableDocs: e.ENABLE_API_DOCS,
    },
    database: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL, poolMax: e.DATABASE_POOL_MAX },
    redis: { url: e.REDIS_URL, queuePrefix: e.QUEUE_PREFIX },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    mail: { smtpUrl: e.SMTP_URL ?? null, from: e.MAIL_FROM },
    storage: { kind: e.BLOB_STORAGE, blobDir: e.BLOB_STORAGE_DIR },
    ai: {
      llmProvider: e.LLM_PROVIDER,
      anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
      models: { default: e.ANTHROPIC_MODEL, fast: e.ANTHROPIC_MODEL_FAST },
      embeddingProvider: e.EMBEDDING_PROVIDER,
      embeddingBaseUrl: e.EMBEDDING_BASE_URL,
      embeddingModel: e.EMBEDDING_MODEL,
      embeddingApiKey: e.EMBEDDING_API_KEY ?? null,
      embeddingSendDimensions: e.EMBEDDING_SEND_DIMENSIONS,
    },
    worker: {
      outboxPollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      concurrency: {
        agentRuns: e.WORKER_CONCURRENCY_AGENT_RUNS,
        ingestion: e.WORKER_CONCURRENCY_INGESTION,
        evaluations: e.WORKER_CONCURRENCY_EVALUATIONS,
        email: e.WORKER_CONCURRENCY_EMAIL,
      },
    },
    limits: {
      maxActiveRunsPerOrg: e.MAX_ACTIVE_RUNS_PER_ORG,
      dailyTokenBudgetPerOrg: e.DAILY_TOKEN_BUDGET_PER_ORG,
    },
    web: { serve: e.SERVE_WEB, dir: e.WEB_DIR },
    startup: { migrate: e.MIGRATE_ON_START, seed: e.SEED_ON_START },
    selfPing: e.SELF_PING,
  };
}
