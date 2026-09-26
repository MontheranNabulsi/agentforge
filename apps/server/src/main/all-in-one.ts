import { loadConfig } from './config';
import { loadEnvFile } from './env-file';
import { createContainer } from './container';
import { buildApi } from './http';
import { migrateAll, onShutdown } from './lifecycle';
import { seedDemo } from './seed/seed-demo';
import { attachWeb } from './web';
import { startWorkerRuntime } from './worker-runtime';

/**
 * API + background worker (+ the Next.js web app when SERVE_WEB=true) in one process.
 * Used for local development and for free single-instance hosting. In a larger deployment
 * run api.ts and worker.ts as separate services instead; the code is the same.
 */
async function main() {
  loadEnvFile();
  const config = loadConfig();
  const container = createContainer(config, 'all-in-one');
  if (config.startup.migrate) await migrateAll(container);

  const app = await buildApi(container);
  const web = config.web.serve
    ? await attachWeb(app, {
        dir: config.web.dir,
        dev: config.env === 'development',
        logger: container.logger,
      })
    : null;
  await app.listen({ port: config.http.port, host: config.http.host });
  const worker = await startWorkerRuntime(container);

  onShutdown(container, [() => app.close(), () => worker.stop(), async () => web?.close?.()]);

  if (config.selfPing) {
    const url = new URL('/health/live', config.http.appUrl).toString();
    const timer = setInterval(() => {
      fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((error: unknown) =>
        container.logger.warn({ err: error }, 'self-ping failed'),
      );
    }, 10 * 60_000);
    timer.unref();
    container.logger.info({ url }, 'self-ping enabled');
  }

  if (config.startup.seed) {
    seedDemo(container, { executeInline: false }).catch((error: unknown) =>
      container.logger.error({ err: error }, 'demo seed failed'),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
