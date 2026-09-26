import { loadConfig } from './config';
import { loadEnvFile } from './env-file';
import { createContainer } from './container';
import { buildApi } from './http';
import { migrateAll, onShutdown } from './lifecycle';
import { attachWeb } from './web';

/** The HTTP API alone (scale it horizontally; run worker.ts for background work). */
async function main() {
  loadEnvFile();
  const config = loadConfig();
  const container = createContainer(config, 'api');
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
  onShutdown(container, [() => app.close(), async () => web?.close?.()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
