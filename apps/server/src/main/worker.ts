import { loadConfig } from './config';
import { loadEnvFile } from './env-file';
import { createContainer } from './container';
import { onShutdown } from './lifecycle';
import { startWorkerRuntime } from './worker-runtime';

/** Background work only: outbox relay, queues (ingestion, agent runs, evaluations, email), maintenance. */
async function main() {
  loadEnvFile();
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  const runtime = await startWorkerRuntime(container);
  onShutdown(container, [() => runtime.stop()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
