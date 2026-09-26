// Bundles the server entry points with esbuild. Workspace packages (@agentforge/contracts,
// shipped as TypeScript source) are bundled in; everything else stays in node_modules.
import { cp, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith('@agentforge/'),
);

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: [
    'src/main/all-in-one.ts',
    'src/main/api.ts',
    'src/main/worker.ts',
    'src/main/cli.ts',
  ],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  external: [...external, 'pino-pretty', 'next'],
  logLevel: 'info',
  banner: {
    // Some CommonJS dependencies call require(); give the ESM bundle one.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
await cp('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('server build complete');
