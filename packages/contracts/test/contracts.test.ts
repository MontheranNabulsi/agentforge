import { describe, expect, it } from 'vitest';
import { CaseExpectations, CreateAgentInput, RegisterInput, RunEvent, ToolGrant } from '../src';

describe('shared contracts', () => {
  it('rejects weak registration input', () => {
    expect(
      RegisterInput.safeParse({ name: 'A', email: 'a@example.com', password: 'short' }).success,
    ).toBe(false);
    expect(
      RegisterInput.safeParse({
        name: 'A',
        email: 'not-an-email',
        password: 'long-enough-password',
      }).success,
    ).toBe(false);
    expect(
      RegisterInput.safeParse({
        name: 'A',
        email: 'a@example.com',
        password: 'long-enough-password',
      }).success,
    ).toBe(true);
  });

  it('only accepts known tools in grants', () => {
    expect(ToolGrant.safeParse({ tool: 'calculator' }).success).toBe(true);
    expect(ToolGrant.safeParse({ tool: 'shell_exec' }).success).toBe(false);
  });

  it('fills agent defaults', () => {
    const agent = CreateAgentInput.parse({
      name: 'Helper',
      instructions: 'Answer questions carefully.',
    });
    expect(agent.limits).toEqual({
      maxSteps: 8,
      maxToolCalls: 10,
      maxTokens: 60_000,
      timeoutSeconds: 180,
    });
    expect(agent.modelProfile).toBe('default');
  });

  it('validates evaluation expectations and run events', () => {
    expect(
      CaseExpectations.safeParse({ mustCallTools: ['calculator'], mustRefuse: false }).success,
    ).toBe(true);
    expect(CaseExpectations.safeParse({ mustCallTools: ['rm_rf'] }).success).toBe(false);
    expect(
      RunEvent.safeParse({
        type: 'message.delta',
        stepId: '01a0ddff-e440-7d41-882c-f4139b645250',
        text: 'hi',
      }).success,
    ).toBe(true);
    expect(RunEvent.safeParse({ type: 'unknown.event' }).success).toBe(false);
  });
});
