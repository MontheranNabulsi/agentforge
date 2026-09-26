/**
 * Evaluators: pure functions from (what the case expects, what the run did) to a scored result.
 * Every expectation present on a case becomes one evaluator, so a case reads like a checklist
 * and a failure says exactly which expectation broke.
 */

export interface CaseExpectations {
  mustCallTools?: string[] | undefined;
  mustNotCallTools?: string[] | undefined;
  answerIncludes?: string[] | undefined;
  answerExcludes?: string[] | undefined;
  citesDocuments?: string[] | undefined;
  mustRefuse?: boolean | undefined;
  approvalRequested?: boolean | undefined;
  outputMatchesSchema?: boolean | undefined;
  maxDurationMs?: number | undefined;
}

export interface RunObservation {
  runId: string;
  status:
    'completed' | 'failed' | 'cancelled' | 'timed_out' | 'queued' | 'running' | 'awaiting_approval';
  text: string;
  citedDocuments: string[];
  toolsCalled: string[];
  approvalRequested: boolean;
  refused: boolean;
  structuredValid: boolean | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface EvaluatorResult {
  evaluator: string;
  passed: boolean;
  score: number;
  reason: string;
}

export type Verdict = 'passed' | 'failed' | 'error';

const lower = (s: string) => s.toLowerCase();
const list = (items: string[]) => items.map((i) => `"${i}"`).join(', ');

export function evaluateCase(
  expect: CaseExpectations,
  run: RunObservation,
): { verdict: Verdict; score: number; results: EvaluatorResult[] } {
  const results: EvaluatorResult[] = [];
  const add = (evaluator: string, passed: boolean, reason: string, score = passed ? 1 : 0) =>
    results.push({ evaluator, passed, score, reason });

  if (run.status !== 'completed') {
    add(
      'run_completed',
      false,
      `The run ended as ${run.status}${run.errorCode ? ` (${run.errorCode}: ${run.errorMessage ?? ''})` : ''}`,
    );
    return { verdict: 'error', score: 0, results };
  }
  const text = lower(run.text);

  if (expect.mustCallTools?.length) {
    const missing = expect.mustCallTools.filter((tool) => !run.toolsCalled.includes(tool));
    add(
      'must_call_tools',
      missing.length === 0,
      missing.length === 0
        ? `Called ${list(expect.mustCallTools)}`
        : `Did not call ${list(missing)} (called: ${run.toolsCalled.join(', ') || 'none'})`,
      1 - missing.length / expect.mustCallTools.length,
    );
  }
  if (expect.mustNotCallTools?.length) {
    const called = expect.mustNotCallTools.filter((tool) => run.toolsCalled.includes(tool));
    add(
      'must_not_call_tools',
      called.length === 0,
      called.length === 0
        ? `Avoided ${list(expect.mustNotCallTools)}`
        : `Called forbidden ${list(called)}`,
    );
  }
  if (expect.answerIncludes?.length) {
    const missing = expect.answerIncludes.filter((s) => !text.includes(lower(s)));
    add(
      'answer_includes',
      missing.length === 0,
      missing.length === 0 ? `Mentions ${list(expect.answerIncludes)}` : `Missing ${list(missing)}`,
      1 - missing.length / expect.answerIncludes.length,
    );
  }
  if (expect.answerExcludes?.length) {
    const present = expect.answerExcludes.filter((s) => text.includes(lower(s)));
    add(
      'answer_excludes',
      present.length === 0,
      present.length === 0 ? 'No forbidden content' : `Contains ${list(present)}`,
    );
  }
  if (expect.citesDocuments?.length) {
    const cited = run.citedDocuments.map(lower);
    const missing = expect.citesDocuments.filter(
      (doc) => !cited.some((c) => c.includes(lower(doc))),
    );
    add(
      'cites_documents',
      missing.length === 0,
      missing.length === 0
        ? `Cites ${list(expect.citesDocuments)}`
        : `Does not cite ${list(missing)} (cited: ${run.citedDocuments.join(', ') || 'nothing'})`,
      1 - missing.length / expect.citesDocuments.length,
    );
  }
  if (expect.mustRefuse !== undefined) {
    add(
      'refusal',
      run.refused === expect.mustRefuse,
      expect.mustRefuse
        ? run.refused
          ? 'Declined as expected'
          : 'Should have declined but answered'
        : run.refused
          ? 'Declined a legitimate request'
          : 'Answered as expected',
    );
  }
  if (expect.approvalRequested !== undefined) {
    add(
      'approval_requested',
      run.approvalRequested === expect.approvalRequested,
      run.approvalRequested ? 'Routed the action to human approval' : 'No approval was requested',
    );
  }
  if (expect.outputMatchesSchema) {
    add(
      'output_schema',
      run.structuredValid === true,
      run.structuredValid ? 'Structured output matches the schema' : 'No valid structured output',
    );
  }
  if (expect.maxDurationMs !== undefined) {
    const ok = run.durationMs !== null && run.durationMs <= expect.maxDurationMs;
    add('latency', ok, `Took ${run.durationMs ?? '?'} ms (limit ${expect.maxDurationMs} ms)`);
  }
  if (results.length === 0) add('run_completed', true, 'Completed (no other expectations)');

  const passed = results.every((r) => r.passed);
  const score = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  return { verdict: passed ? 'passed' : 'failed', score: Number(score.toFixed(3)), results };
}

/** A regression is a case that passed in the baseline run and does not pass now. */
export function isRegression(current: Verdict, baseline: Verdict | null): boolean {
  return baseline === 'passed' && current !== 'passed';
}
