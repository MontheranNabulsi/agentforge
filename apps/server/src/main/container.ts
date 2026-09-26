import type { Redis } from 'ioredis';
import { RedisJsonCache } from '../platform/cache/json-cache';
import { createDatabase, type DatabaseHandle } from '../platform/database/client';
import { DrizzleTransactionRunner } from '../platform/database/transaction';
import { IdempotencyStore } from '../platform/http/idempotency';
import { LogMailer, SmtpMailer, type Mailer } from '../platform/mail/mailer';
import { LogErrorReporter, type ErrorReporter } from '../platform/observability/error-reporter';
import { createLogger, type Logger } from '../platform/observability/logger';
import { createRedis } from '../platform/queue/connection';
import { OutboxWriter } from '../platform/queue/outbox';
import { QueueRegistry } from '../platform/queue/queues';
import { Argon2PasswordHasher } from '../platform/security/password-hasher';
import { secureTokens } from '../platform/security/secure-token';
import { systemClock, type Clock } from '../shared-kernel/ports';
import type { EmbeddingProvider, LlmProvider } from '../shared-kernel/ai';
import type { SafeHttpClient } from '../platform/outbound-http/safe-http-client';
import { AuditLog, AuditQueries, DrizzleAuditEventRepository } from '../modules/audit';
import {
  DrizzleCredentialRepository,
  DrizzlePasswordResetRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  IdentityUseCases,
} from '../modules/identity';
import { InsightsQueries, SqlInsightsReadModel } from '../modules/insights';
import {
  DrizzleMembershipRepository,
  DrizzleOrganizationRepository,
  OrganizationAccess,
  OrganizationUseCases,
} from '../modules/organizations';
import { DrizzleProjectRepository, ProjectAccess, ProjectUseCases } from '../modules/projects';
import { buildAiProviders } from './ai-providers';
import type { AppConfig } from './config';
import { buildKnowledgeModule } from './knowledge-wiring';
import { buildAgentsModule } from './agents-wiring';
import { buildChannels } from './channels-wiring';

export type ProcessRole = 'api' | 'worker' | 'all-in-one' | 'cli';

/**
 * The composition root: the only place that knows every concrete class.
 * Everything else receives its dependencies through constructors (no DI container:
 * the wiring is plain code you can read top to bottom).
 */
export function createContainer(
  config: AppConfig,
  role: ProcessRole,
  overrides: Partial<ContainerOverrides> = {},
) {
  const logger: Logger =
    overrides.logger ??
    createLogger({
      level: config.log.level,
      pretty: config.log.pretty,
      service: `agentforge-${role}`,
      version: config.version,
    });
  const errors: ErrorReporter = new LogErrorReporter(logger);
  const database: DatabaseHandle = createDatabase({
    url: config.database.url,
    ssl: config.database.ssl,
    maxConnections: config.database.poolMax,
    applicationName: `agentforge-${role}`,
  });
  const db = database.db;
  const redis: Redis = overrides.redis ?? createRedis(config.redis.url, `agentforge-${role}`);
  const clock: Clock = overrides.clock ?? systemClock;
  const tx = new DrizzleTransactionRunner(db);
  const queues = new QueueRegistry(redis, config.redis.queuePrefix);
  const jobs = new OutboxWriter(db);
  const cache = new RedisJsonCache(redis);
  const idempotency = new IdempotencyStore(db, tx);
  const mailer: Mailer =
    overrides.mailer ??
    (config.mail.smtpUrl
      ? new SmtpMailer(config.mail.smtpUrl, config.mail.from)
      : new LogMailer(logger));

  // --- audit ---------------------------------------------------------------------------
  const auditRepository = new DrizzleAuditEventRepository(db, () => clock.now());
  const audit = new AuditLog(auditRepository);
  const auditQueries = new AuditQueries(auditRepository);

  // --- organizations -------------------------------------------------------------------
  const organizationRepository = new DrizzleOrganizationRepository(db);
  const membershipRepository = new DrizzleMembershipRepository(db);
  const organizationAccess = new OrganizationAccess(organizationRepository, membershipRepository);
  const userRepository = new DrizzleUserRepository(db);
  const organizations = new OrganizationUseCases({
    users: { findByEmail: async (email) => userRepository.findByEmail(email) },
    organizations: organizationRepository,
    memberships: membershipRepository,
    access: organizationAccess,
    audit,
    tx,
    clock,
  });

  // --- identity ------------------------------------------------------------------------
  const identity = new IdentityUseCases({
    users: userRepository,
    credentials: new DrizzleCredentialRepository(db),
    sessions: new DrizzleSessionRepository(db),
    resets: new DrizzlePasswordResetRepository(db),
    hasher: overrides.passwordHasher ?? new Argon2PasswordHasher(),
    tokens: secureTokens,
    tx,
    clock,
    jobs,
    appUrl: config.http.appUrl,
    onUserRegistered: [organizations.createPersonalOrganization],
  });

  // --- projects ------------------------------------------------------------------------
  const projectRepository = new DrizzleProjectRepository(db);
  const projectAccess = new ProjectAccess(projectRepository, organizationAccess);
  const onProjectCreated: ConstructorParameters<typeof ProjectUseCases>[0]['onProjectCreated'] = [];
  const projects = new ProjectUseCases({
    projects: projectRepository,
    organizationAccess,
    projectAccess,
    audit,
    tx,
    clock,
    onProjectCreated,
  });

  // --- AI providers, knowledge, agents ---------------------------------------------------
  const ai = buildAiProviders(config, logger, overrides);
  const knowledge = buildKnowledgeModule({
    config,
    db,
    tx,
    clock,
    jobs,
    audit,
    projectAccess,
    cache,
    ai,
    logger,
  });
  const agents = buildAgentsModule({
    config,
    db,
    pool: database.pool,
    tx,
    clock,
    jobs,
    audit,
    projectAccess,
    organizationAccess,
    knowledge,
    redis,
    ai,
    logger,
    errors,
    ...(overrides.checkpointer ? { checkpointer: overrides.checkpointer } : {}),
    ...(overrides.httpClient ? { httpClient: overrides.httpClient } : {}),
  });
  onProjectCreated.push(agents.onProjectCreated);
  const { conversations, evaluations } = buildChannels({
    config,
    db,
    tx,
    clock,
    jobs,
    audit,
    projectAccess,
    agents,
    ai,
  });

  // --- insights ------------------------------------------------------------------------
  const insights = new InsightsQueries({
    readModel: new SqlInsightsReadModel(db),
    organizationAccess,
    projectAccess,
    auditQueries,
    cache,
    clock,
  });

  const close = async () => {
    await agents.close();
    await queues.close();
    await database.close();
    redis.disconnect();
  };

  return {
    config,
    role,
    logger,
    errors,
    database,
    db,
    redis,
    clock,
    tx,
    queues,
    jobs,
    cache,
    idempotency,
    mailer,
    audit,
    auditQueries,
    organizationAccess,
    organizations,
    identity,
    projectAccess,
    projects,
    ai,
    knowledge,
    agents,
    conversations,
    evaluations,
    insights,
    close,
  };
}

export interface ContainerOverrides {
  logger: Logger;
  redis: Redis;
  clock: Clock;
  mailer: Mailer;
  passwordHasher: Argon2PasswordHasher;
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  checkpointer: 'postgres' | 'memory';
  httpClient: SafeHttpClient;
}

export type Container = ReturnType<typeof createContainer>;
