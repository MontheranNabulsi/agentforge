import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { loadConfig } from './config';
import { loadEnvFile } from './env-file';
import { createContainer, type Container } from './container';
import { buildApi } from './http';
import { migrateAll } from './lifecycle';
import { seedDemo } from './seed/seed-demo';

const USAGE = `AgentForge CLI

  migrate                         apply database migrations (and LangGraph checkpoint tables)
  seed                            create the demo workspace (idempotent)
  evals [--project <slug|id>] [--dataset <name>] [--min-pass-rate <0..1>] [--fail-on-regression]
                                  run evaluation datasets inline and print a report
  openapi [--out <file>]          write the OpenAPI document
`;

async function runEvals(
  container: Container,
  args: { project?: string; dataset?: string; minPassRate: number; failOnRegression: boolean },
): Promise<number> {
  const { db, evaluations, agents } = container;
  const { rows: projects } = await db.execute<{
    id: string;
    slug: string;
    name: string;
    organization_id: string;
  }>(
    args.project
      ? sql`SELECT id, slug, name, organization_id FROM projects WHERE (id::text = ${args.project} OR slug = ${args.project}) AND archived_at IS NULL`
      : sql`SELECT p.id, p.slug, p.name, p.organization_id FROM projects p WHERE EXISTS (SELECT 1 FROM evaluation_datasets d WHERE d.project_id = p.id) AND p.archived_at IS NULL`,
  );
  if (projects.length === 0) {
    console.error('No project with evaluation datasets found. Run "seed" first or pass --project.');
    return 2;
  }
  let failed = false;
  for (const project of projects) {
    const { rows: owners } = await db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM organization_members WHERE organization_id = ${project.organization_id} AND role = 'owner' LIMIT 1`,
    );
    const actor = { userId: owners[0]!.user_id, sessionId: null };
    const datasets = (await evaluations.listDatasets(actor, project.id)).filter(
      (d) => !args.dataset || d.name === args.dataset,
    );
    const agentList = await agents.agents.list(actor, project.id);
    for (const dataset of datasets) {
      const agentId = dataset.lastRun?.agentId ?? agentList.find((a) => a.isDefault)?.id;
      if (!agentId) continue;
      const started = await evaluations.startRun({ ...actor, name: 'CLI' }, dataset.id, {
        agentId,
      });
      await evaluations.execute(started.id);
      const report = await evaluations.getRun(actor, started.id);
      const rate = report.totalCases > 0 ? report.passed / report.totalCases : 0;
      console.log(
        `\n${project.name} / ${dataset.name} (agent ${report.agentName} v${report.agentVersion}, ${report.provider}:${report.model}, prompt ${report.promptVersion})`,
      );
      for (const result of report.results) {
        const mark =
          result.verdict === 'passed' ? 'PASS' : result.verdict === 'failed' ? 'FAIL' : 'ERR ';
        console.log(`  ${mark}  ${result.caseName}${result.regression ? '  (regression)' : ''}`);
        if (result.verdict !== 'passed') {
          for (const e of result.evaluatorResults.filter((r) => !r.passed))
            console.log(`          ${e.evaluator}: ${e.reason}`);
        }
      }
      console.log(
        `  pass rate ${(rate * 100).toFixed(1)}% (${report.passed}/${report.totalCases}), regressions: ${report.regressions}`,
      );
      if (rate < args.minPassRate || (args.failOnRegression && report.regressions > 0))
        failed = true;
    }
  }
  return failed ? 1 : 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: 'string' },
      dataset: { type: 'string' },
      'min-pass-rate': { type: 'string', default: '0' },
      'fail-on-regression': { type: 'boolean', default: false },
      out: { type: 'string', default: 'openapi.json' },
    },
    allowPositionals: true,
  });
  loadEnvFile();
  const config = loadConfig();
  const container = createContainer(config, 'cli');
  try {
    switch (command) {
      case 'migrate':
        await migrateAll(container);
        return 0;
      case 'seed':
        await seedDemo(container, { executeInline: true });
        return 0;
      case 'evals':
        return await runEvals(container, {
          ...(values.project ? { project: values.project } : {}),
          ...(values.dataset ? { dataset: values.dataset } : {}),
          minPassRate: Number(values['min-pass-rate']),
          failOnRegression: values['fail-on-regression'] === true,
        });
      case 'openapi': {
        const app = await buildApi(container);
        await app.ready();
        await writeFile(values.out!, `${JSON.stringify(app.swagger(), null, 2)}\n`);
        console.log(`wrote ${values.out}`);
        await app.close();
        return 0;
      }
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await container.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
