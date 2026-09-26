import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { problem } from '../platform/http/problem';
import type { App } from '../platform/http/server';
import type { Logger } from '../platform/observability/logger';

interface NextServer {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close?(): Promise<void>;
}

/**
 * All-in-one mode: the API process also serves the Next.js web app (a documented Next.js
 * "custom server"). Fastify keeps /api, /health and /docs; every other path goes to Next.
 * One process and one port is what makes the free single-instance deployment possible.
 * `next` is resolved from the web app's own node_modules, so the API bundle does not depend on it.
 */
export async function attachWeb(
  app: App,
  options: { dir: string; dev: boolean; logger: Logger },
): Promise<NextServer> {
  const webDir = resolve(options.dir);
  const requireFromWeb = createRequire(join(webDir, 'package.json'));
  type CreateNext = (opts: Record<string, unknown>) => NextServer;
  const nextModule = requireFromWeb('next') as CreateNext | { default: CreateNext };
  const createNext: CreateNext = typeof nextModule === 'function' ? nextModule : nextModule.default;
  const nextApp = createNext({ dev: options.dev, dir: webDir, quiet: !options.dev });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    schema: { hide: true },
    handler: async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply
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
      }
      reply.hijack();
      await handle(request.raw, reply.raw);
    },
  });
  options.logger.info({ dir: webDir, dev: options.dev }, 'serving the web app from this process');
  return nextApp;
}
