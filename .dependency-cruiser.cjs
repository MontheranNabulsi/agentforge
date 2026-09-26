/**
 * Architecture rules, checked in CI (`pnpm arch`). They encode the layering described in
 * docs/architecture.md: pure domain, application that depends on ports only, infrastructure
 * and presentation at the edge, and modules that talk to each other through their index.ts.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      comment:
        'Domain code imports only its own module’s domain and the shared kernel (no frameworks, no I/O).',
      severity: 'error',
      from: { path: '^apps/server/src/modules/([^/]+)/domain/' },
      to: {
        pathNot: ['^apps/server/src/modules/$1/domain/', '^apps/server/src/shared-kernel/'],
      },
    },
    {
      name: 'application-depends-on-ports',
      comment:
        'Application code must not reach into infrastructure, presentation, the platform layer, the schema or the composition root.',
      severity: 'error',
      from: { path: '^apps/server/src/modules/[^/]+/application/' },
      to: {
        path: [
          '^apps/server/src/modules/[^/]+/(infrastructure|presentation)/',
          '^apps/server/src/platform/',
          '^apps/server/src/db/',
          '^apps/server/src/main/',
          '^(node_modules/)?(drizzle-orm|pg|ioredis|bullmq|fastify|@langchain|@anthropic-ai)',
        ],
      },
    },
    {
      name: 'modules-use-public-api',
      comment: 'Another module is reached only through its index.ts.',
      severity: 'error',
      from: { path: '^apps/server/src/modules/([^/]+)/' },
      to: {
        path: '^apps/server/src/modules/[^/]+/',
        pathNot: ['^apps/server/src/modules/$1/', '^apps/server/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'langgraph-only-in-adapter',
      comment: 'LangGraph is an implementation detail of one adapter.',
      severity: 'error',
      from: { pathNot: '^apps/server/src/modules/agents/infrastructure/langgraph/' },
      to: { path: '@langchain/' },
    },
    {
      name: 'shared-kernel-is-standalone',
      severity: 'error',
      from: { path: '^apps/server/src/shared-kernel/' },
      to: { path: '^apps/server/src/(modules|platform|db|main)/' },
    },
    {
      name: 'platform-knows-no-modules',
      severity: 'error',
      from: { path: '^apps/server/src/platform/' },
      to: { path: '^apps/server/src/(modules|main)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
