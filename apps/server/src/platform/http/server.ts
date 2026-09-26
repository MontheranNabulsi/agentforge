import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';
import { MAX_UPLOAD_BYTES } from '@agentforge/contracts';
import type { ErrorReporter } from '../observability/error-reporter';
import type { Logger } from '../observability/logger';
import { requestContext } from '../observability/request-context';
import { SESSION_COOKIE, type AuthContext } from './auth-context';
import { problem, toProblem } from './problem';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; latencyMs: number | null; error?: string }>;
}

export interface HttpServerOptions {
  logger: Logger;
  version: string;
  allowedOrigins: string[];
  /** How many reverse-proxy hops to trust for the client IP (0 = none). */
  trustProxyHops: number;
  rateLimitRedis: Redis | null;
  errors: ErrorReporter;
  authenticate: (
    token: string,
    meta: { ip: string; userAgent: string | undefined },
  ) => Promise<AuthContext | null>;
  readiness: () => Promise<ReadinessReport>;
  registerApiRoutes: (api: App) => Promise<void>;
  enableDocs: boolean;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Builds the HTTP server. The request lifecycle, in hook order:
 *   onRequest: request id → correlation context → session → CSRF origin check
 *   preValidation/preHandler: Zod schema validation, route-level rate limits
 *   handler: calls exactly one application use case
 *   onSend: echo x-request-id
 *   error handler: every failure becomes RFC 9457 problem details
 */
export async function buildHttpServer(options: HttpServerOptions): Promise<App> {
  const app = Fastify({
    loggerInstance: options.logger as FastifyBaseLogger,
    trustProxy:
      options.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < options.trustProxyHops
        : false,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      return value && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Correlation context for everything that happens while serving this request.
  app.addHook('onRequest', (request, _reply, done) => {
    requestContext.run({ requestId: String(request.id), ip: request.ip }, done);
  });

  await app.register(cookie);
  await app.register(helmet, {
    // Pages served by Next.js (all-in-one mode) set their own CSP; the API returns JSON.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });
  await app.register(rateLimit, {
    global: false,
    enableDraftSpec: true,
    ...(options.rateLimitRedis
      ? { redis: options.rateLimitRedis, nameSpace: 'agentforge-rl:' }
      : {}),
    keyGenerator: (request) => request.auth?.user.id ?? request.ip,
    errorResponseBuilder: (request, context) => ({
      ...problem(
        429,
        'RATE_LIMITED',
        `Too many requests; retry in ${Math.ceil(context.ttl / 1000)}s`,
        request,
      ),
      statusCode: 429,
    }),
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const auth = await options.authenticate(token, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    if (auth) {
      request.auth = auth;
      requestContext.set({ userId: auth.user.id });
    }
  });

  // CSRF: a browser sends the session cookie with cross-site requests (for top-level POSTs
  // even with SameSite=Lax in some cases), but it always sends Origin on them. Reject
  // state-changing requests that carry the cookie from an origin we don't serve.
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) return;
    if (!request.cookies[SESSION_COOKIE]) return;
    const origin = request.headers.origin ?? originOf(request.headers.referer);
    if (!origin || !options.allowedOrigins.includes(origin)) {
      await reply
        .status(403)
        .type('application/problem+json')
        .send(problem(403, 'CSRF_ORIGIN_REJECTED', 'Request origin is not allowed', request));
    }
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', String(request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const body = toProblem(error, request);
    if (body.status >= 500) {
      options.errors.capture(error, { route: request.routeOptions.url, method: request.method });
    } else {
      request.log.info({ code: body.code, status: body.status }, 'request rejected');
    }
    if (body.status === 429 && typeof (error as { headers?: unknown }).headers === 'object') {
      void reply.headers((error as { headers: Record<string, string> }).headers);
    }
    void reply.status(body.status).type('application/problem+json').send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send(
        problem(
          404,
          'ROUTE_NOT_FOUND',
          `No route for ${request.method} ${request.url.split('?')[0]}`,
          request,
        ),
      );
  });

  if (options.enableDocs) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'AgentForge API',
          version: options.version,
          description:
            'REST API for AgentForge. Authenticate with the session cookie set by POST /api/v1/auth/login. ' +
            'Errors are RFC 9457 problem details. Lists use cursor pagination.',
        },
        components: {
          securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } },
        },
        security: [{ session: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(scalar, { routePrefix: '/docs' });
  }

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_request, reply) => {
    const report = await options.readiness();
    return reply.status(report.ok ? 200 : 503).send(report);
  });

  await app.register(
    async (api) => options.registerApiRoutes(api.withTypeProvider<ZodTypeProvider>()),
    {
      prefix: '/api/v1',
    },
  );

  return app;
}

function originOf(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
