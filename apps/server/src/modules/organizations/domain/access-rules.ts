import { conflict, forbidden } from '../../../shared-kernel/errors';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'org:read'
  | 'org:update'
  | 'members:read'
  | 'members:manage'
  | 'audit:read'
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:archive'
  | 'document:read'
  | 'document:upload'
  | 'document:delete'
  | 'agent:read'
  | 'agent:manage'
  | 'conversation:read'
  | 'conversation:create'
  | 'run:read'
  | 'run:create'
  | 'run:cancel'
  | 'approval:read'
  | 'approval:decide'
  | 'evaluation:read'
  | 'evaluation:run'
  | 'evaluation:manage';

const VIEWER: readonly Permission[] = [
  'org:read',
  'members:read',
  'project:read',
  'document:read',
  'agent:read',
  'conversation:read',
  'run:read',
  'approval:read',
  'evaluation:read',
];

const MEMBER: readonly Permission[] = [
  ...VIEWER,
  'document:upload',
  'document:delete',
  'conversation:create',
  'run:create',
  'run:cancel',
  'approval:decide',
  'evaluation:run',
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'org:update',
  'members:manage',
  'audit:read',
  'project:create',
  'project:update',
  'project:archive',
  'agent:manage',
  'evaluation:manage',
];

/** The RBAC matrix. One place, pure data, unit-tested row by row. */
export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ADMIN),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
  viewer: new Set(VIEWER),
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].has(permission);
}

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Role changes: admins manage non-owners; only owners grant or revoke ownership;
 * an organization always keeps at least one owner.
 */
export function assertRoleChangeAllowed(params: {
  actorRole: Role;
  targetRole: Role;
  newRole: Role;
  ownerCount: number;
}): void {
  const { actorRole, targetRole, newRole, ownerCount } = params;
  if (!can(actorRole, 'members:manage')) {
    throw forbidden('MEMBERS_MANAGE_REQUIRED', 'Only admins and owners can change roles');
  }
  if ((targetRole === 'owner' || newRole === 'owner') && actorRole !== 'owner') {
    throw forbidden('OWNER_REQUIRED', 'Only owners can grant or revoke ownership');
  }
  if (targetRole === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    throw conflict('LAST_OWNER', 'An organization needs at least one owner');
  }
}

/** Anyone may leave; removing others needs members:manage; the last owner cannot go. */
export function assertMemberRemovalAllowed(params: {
  actorRole: Role;
  targetRole: Role;
  ownerCount: number;
  removingSelf: boolean;
}): void {
  const { actorRole, targetRole, ownerCount, removingSelf } = params;
  if (!removingSelf && !can(actorRole, 'members:manage')) {
    throw forbidden('MEMBERS_MANAGE_REQUIRED', 'Only admins and owners can remove members');
  }
  if (!removingSelf && targetRole === 'owner' && actorRole !== 'owner') {
    throw forbidden('OWNER_REQUIRED', 'Only owners can remove an owner');
  }
  if (targetRole === 'owner' && ownerCount <= 1) {
    throw conflict('LAST_OWNER', 'An organization needs at least one owner');
  }
}
