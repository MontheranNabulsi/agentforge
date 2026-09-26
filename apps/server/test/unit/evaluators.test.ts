import { describe, expect, it } from 'vitest';
import {
  evaluateCase,
  isRegression,
  type RunObservation,
} from '../../src/modules/evaluations/domain/evaluators';

const base: RunObservation = {
  runId: 'r',
  status: 'completed',
  text: 'Annual plans can be refunded within 30 days [1].',
  citedDocuments: ['Refund Policy'],
  toolsCalled: ['knowledge_search'],
  approvalRequested: false,
  refused: false,
  structuredValid: null,
  durationMs: 1200,
  errorCode: null,
  errorMessage: null,
};

describe('evaluators', () => {
  it('passes when every expectation holds', () => {
    const result = evaluateCase(
      {
        answerIncludes: ['30 days'],
        citesDocuments: ['refund policy'],
        mustNotCallTools: ['http_request'],
        maxDurationMs: 5000,
      },
      base,
    );
    expect(result.verdict).toBe('passed');
    expect(result.results).toHaveLength(4);
    expect(result.score).toBe(1);
  });

  it('fails with a reason per broken expectation and partial credit', () => {
    const result = evaluateCase(
      { answerIncludes: ['30 days', '14 days'], mustCallTools: ['calculator'] },
      base,
    );
    expect(result.verdict).toBe('failed');
    expect(result.results.find((r) => r.evaluator === 'answer_includes')?.score).toBe(0.5);
    expect(result.results.find((r) => r.evaluator === 'must_call_tools')?.reason).toContain(
      'calculator',
    );
  });

  it('marks runs that did not complete as errors', () => {
    expect(
      evaluateCase(
        { answerIncludes: ['x'] },
        { ...base, status: 'failed', errorCode: 'LLM_UNAVAILABLE' },
      ).verdict,
    ).toBe('error');
  });

  it('checks refusals and approvals', () => {
    expect(evaluateCase({ mustRefuse: true }, { ...base, refused: true }).verdict).toBe('passed');
    expect(evaluateCase({ mustRefuse: true }, base).verdict).toBe('failed');
    expect(
      evaluateCase({ approvalRequested: true }, { ...base, approvalRequested: true }).verdict,
    ).toBe('passed');
  });

  it('flags regressions only for cases that passed before', () => {
    expect(isRegression('failed', 'passed')).toBe(true);
    expect(isRegression('error', 'passed')).toBe(true);
    expect(isRegression('failed', 'failed')).toBe(false);
    expect(isRegression('failed', null)).toBe(false);
  });
});
