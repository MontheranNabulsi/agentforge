import { describe, expect, it } from 'vitest';
import { evaluateApproval, mayApprove } from '../../src/modules/agents/domain/approval-policy';

describe('approval policy', () => {
  it.each([
    // effect, risk, autoApprove → required, preApproved, approver roles
    ['read', 'low', false, false, false, []],
    ['external_read', 'medium', false, false, false, []],
    ['write', 'low', false, true, false, ['owner', 'admin', 'member']],
    ['write', 'medium', true, false, true, ['owner', 'admin', 'member']],
    ['write', 'high', true, true, false, ['owner', 'admin']],
    ['write', 'high', false, true, false, ['owner', 'admin']],
  ] as const)(
    '%s / %s risk / autoApprove=%s',
    (effect, risk, autoApprove, required, preApproved, roles) => {
      const decision = evaluateApproval({
        toolName: 'tool',
        effect,
        risk,
        autoApproveGranted: autoApprove,
      });
      expect(decision.required).toBe(required);
      expect(decision.preApproved).toBe(preApproved);
      expect(decision.approverRoles).toEqual(roles);
    },
  );

  it('never lets a viewer approve, and keeps high-risk actions for admins', () => {
    const high = evaluateApproval({
      toolName: 't',
      effect: 'write',
      risk: 'high',
      autoApproveGranted: false,
    });
    expect(mayApprove('viewer', high)).toBe(false);
    expect(mayApprove('member', high)).toBe(false);
    expect(mayApprove('admin', high)).toBe(true);
  });
});
