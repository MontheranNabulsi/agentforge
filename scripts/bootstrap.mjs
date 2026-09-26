// First-time setup: checks the toolchain, creates .env from the example, prints next steps.
import { copyFileSync, existsSync } from 'node:fs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`AgentForge needs Node.js 24 or newer (found ${process.versions.node}).`);
  process.exit(1);
}
if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example');
}
console.log(`
Next steps:
  1. docker compose up -d postgres redis     # PostgreSQL + pgvector and Redis
  2. pnpm db:migrate && pnpm db:seed          # schema and the demo workspace
  3. pnpm dev                                 # http://localhost:4000

Demo login: demo@agentforge.dev / agentforge-2026
`);
