import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  budgetViolation,
  canTransition,
} from '../../src/modules/agents/domain/run-rules';

const limits = { maxSteps: 3, maxToolCalls: 2, maxTokens: 1000, timeoutSeconds: 60 };

describe('run state machine', () => {
  it('allows the documented transitions only', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
  });
});

describe('budgets', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('passes within limits', () => {
    expect(
      budgetViolation(
        { modelTurns: 2, toolCalls: 2, tokens: 900 },
        limits,
        now,
        new Date(now.getTime() + 1000),
      ),
    ).toBeNull();
  });
  it('stops on model steps, tool calls, tokens and deadline', () => {
    expect(
      budgetViolation({ modelTurns: 3, toolCalls: 0, tokens: 0 }, limits, now, null)?.code,
    ).toBe('BUDGET_EXCEEDED');
    expect(
      budgetViolation({ modelTurns: 0, toolCalls: 3, tokens: 0 }, limits, now, null)?.code,
    ).toBe('BUDGET_EXCEEDED');
    expect(
      budgetViolation({ modelTurns: 0, toolCalls: 0, tokens: 1001 }, limits, now, null)?.code,
    ).toBe('BUDGET_EXCEEDED');
    const late = budgetViolation(
      { modelTurns: 0, toolCalls: 0, tokens: 0 },
      limits,
      now,
      new Date(now.getTime() - 1),
    );
    expect(late?.code).toBe('DEADLINE_EXCEEDED');
    expect(late?.status).toBe('timed_out');
  });
});

describe('backoff with full jitter', () => {
  it('grows exponentially and is capped', () => {
    const max = () => 0.999999;
    expect(backoffDelayMs(1, { baseMs: 100, maxMs: 10_000 }, max)).toBe(99);
    expect(backoffDelayMs(4, { baseMs: 100, maxMs: 10_000 }, max)).toBe(799);
    expect(backoffDelayMs(20, { baseMs: 100, maxMs: 10_000 }, max)).toBe(9999);
    expect(backoffDelayMs(3, { baseMs: 100, maxMs: 10_000 }, () => 0)).toBe(0);
  });
});
