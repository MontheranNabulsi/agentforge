import { describe, expect, it } from 'vitest';
import {
  assertMemberRemovalAllowed,
  assertRoleChangeAllowed,
  can,
} from '../../src/modules/organizations/domain/access-rules';

describe('RBAC matrix', () => {
  it.each([
    ['viewer', 'document:read', true],
    ['viewer', 'document:upload', false],
    ['viewer', 'approval:decide', false],
    ['member', 'run:create', true],
    ['member', 'approval:decide', true],
    ['member', 'agent:manage', false],
    ['member', 'audit:read', false],
    ['admin', 'agent:manage', true],
    ['admin', 'members:manage', true],
    ['owner', 'audit:read', true],
  ] as const)('%s → %s = %s', (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });

  it('keeps at least one owner and reserves ownership changes for owners', () => {
    expect(() =>
      assertRoleChangeAllowed({
        actorRole: 'owner',
        targetRole: 'owner',
        newRole: 'admin',
        ownerCount: 1,
      }),
    ).toThrow(/at least one owner/);
    expect(() =>
      assertRoleChangeAllowed({
        actorRole: 'admin',
        targetRole: 'member',
        newRole: 'owner',
        ownerCount: 1,
      }),
    ).toThrow(/owners/);
    expect(() =>
      assertRoleChangeAllowed({
        actorRole: 'admin',
        targetRole: 'member',
        newRole: 'viewer',
        ownerCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertMemberRemovalAllowed({
        actorRole: 'member',
        targetRole: 'viewer',
        ownerCount: 1,
        removingSelf: false,
      }),
    ).toThrow();
    expect(() =>
      assertMemberRemovalAllowed({
        actorRole: 'member',
        targetRole: 'member',
        ownerCount: 1,
        removingSelf: true,
      }),
    ).not.toThrow();
  });
});
