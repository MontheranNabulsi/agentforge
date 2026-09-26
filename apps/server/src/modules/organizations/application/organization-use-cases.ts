import { conflict, forbidden, notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { slugify } from '../../../shared-kernel/text';
import type { AuditLog } from '../../audit';
import type { User } from '../../identity';
import {
  assertMemberRemovalAllowed,
  assertRoleChangeAllowed,
  type Role,
} from '../domain/access-rules';
import type { OrganizationAccess } from './organization-access';
import type {
  MembershipRepository,
  MemberView,
  Organization,
  OrganizationRepository,
} from './ports';

/** Finds registered users by email (implemented by the identity module). */
export interface UserDirectory {
  findByEmail(email: string): Promise<{ id: string; name: string } | null>;
}

export interface OrganizationDeps {
  users: UserDirectory;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  access: OrganizationAccess;
  audit: AuditLog;
  tx: TransactionRunner;
  clock: Clock;
}

export class OrganizationUseCases {
  constructor(private readonly deps: OrganizationDeps) {}

  async create(
    actor: Actor & { name?: string },
    input: { name: string; slug?: string },
  ): Promise<Organization & { role: Role }> {
    return this.deps.tx.run(async () => {
      const organization = await this.createWithOwner(actor.userId, input.name, input.slug);
      await this.deps.audit.record({
        organizationId: organization.id,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: 'organization.created',
        target: { type: 'organization', id: organization.id },
        metadata: { name: organization.name },
      });
      return { ...organization, role: 'owner' as const };
    });
  }

  /** Registration hook: every new user starts with a personal organization they own. */
  createPersonalOrganization = async (user: User): Promise<void> => {
    const firstName = user.name.split(/\s+/)[0] ?? user.name;
    const organization = await this.createWithOwner(user.id, `${firstName}'s workspace`);
    await this.deps.audit.record({
      organizationId: organization.id,
      actor: { type: 'user', id: user.id, name: user.name },
      action: 'organization.created',
      target: { type: 'organization', id: organization.id },
      metadata: { name: organization.name, personal: true },
    });
  };

  listMine(actor: Actor): Promise<(Organization & { role: Role })[]> {
    return this.deps.organizations.listForUser(actor.userId);
  }

  async get(actor: Actor, organizationId: string): Promise<Organization & { role: Role }> {
    const { organization, role } = await this.deps.access.require(
      actor,
      organizationId,
      'org:read',
    );
    return { ...organization, role };
  }

  async listMembers(actor: Actor, organizationId: string): Promise<MemberView[]> {
    await this.deps.access.require(actor, organizationId, 'members:read');
    return this.deps.memberships.list(organizationId);
  }

  async addMember(
    actor: Actor & { name?: string },
    organizationId: string,
    input: { email: string; role: Exclude<Role, 'owner'> },
  ): Promise<MemberView> {
    const { memberships, access, audit, tx, clock, users } = this.deps;
    await access.require(actor, organizationId, 'members:manage');
    const user = await users.findByEmail(input.email.trim().toLowerCase());
    if (!user)
      throw notFound(
        'USER_NOT_FOUND',
        'No AgentForge account uses this email yet. Ask them to sign up first.',
      );
    return tx.run(async () => {
      if (await memberships.findRole(organizationId, user.id))
        throw conflict('ALREADY_MEMBER', 'This person is already a member');
      if ((input.role as Role) === 'owner')
        throw forbidden('OWNER_REQUIRED', 'Add the person first, then have an owner promote them');
      await memberships.add(organizationId, user.id, input.role, clock.now());
      await audit.record({
        organizationId,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: 'member.added',
        target: { type: 'user', id: user.id },
        metadata: { role: input.role, name: user.name },
      });
      const member = (await memberships.list(organizationId)).find((m) => m.userId === user.id);
      if (!member) throw notFound('MEMBER_NOT_FOUND', 'Member not found');
      return member;
    });
  }

  async changeRole(
    actor: Actor & { name?: string },
    organizationId: string,
    userId: string,
    newRole: Role,
  ): Promise<MemberView> {
    const { memberships, access, audit, tx } = this.deps;
    return tx.run(async () => {
      const { role: actorRole } = await access.require(actor, organizationId, 'members:read');
      const targetRole = await memberships.findRole(organizationId, userId);
      if (!targetRole) throw notFound('MEMBER_NOT_FOUND', 'Member not found');
      assertRoleChangeAllowed({
        actorRole,
        targetRole,
        newRole,
        ownerCount: await memberships.countOwners(organizationId),
      });
      if (targetRole !== newRole) {
        await memberships.updateRole(organizationId, userId, newRole);
        await audit.record({
          organizationId,
          actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
          action: 'member.role_changed',
          target: { type: 'user', id: userId },
          metadata: { from: targetRole, to: newRole },
        });
      }
      const member = (await memberships.list(organizationId)).find((m) => m.userId === userId);
      if (!member) throw notFound('MEMBER_NOT_FOUND', 'Member not found');
      return member;
    });
  }

  async removeMember(
    actor: Actor & { name?: string },
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const { memberships, access, audit, tx } = this.deps;
    await tx.run(async () => {
      const { role: actorRole } = await access.require(actor, organizationId, 'members:read');
      const targetRole = await memberships.findRole(organizationId, userId);
      if (!targetRole) throw notFound('MEMBER_NOT_FOUND', 'Member not found');
      assertMemberRemovalAllowed({
        actorRole,
        targetRole,
        ownerCount: await memberships.countOwners(organizationId),
        removingSelf: actor.userId === userId,
      });
      await memberships.remove(organizationId, userId);
      await audit.record({
        organizationId,
        actor: { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        action: 'member.removed',
        target: { type: 'user', id: userId },
        metadata: { role: targetRole },
      });
    });
  }

  private async createWithOwner(
    ownerId: string,
    name: string,
    requestedSlug?: string,
  ): Promise<Organization> {
    const { organizations, memberships, clock } = this.deps;
    const now = clock.now();
    const organization: Organization = {
      id: newId(now.getTime()),
      name: name.trim(),
      slug: await this.availableSlug(requestedSlug ?? name),
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
    };
    await organizations.create(organization);
    await memberships.add(organization.id, ownerId, 'owner', now);
    return organization;
  }

  private async availableSlug(source: string): Promise<string> {
    const base = slugify(source, 40) || 'workspace';
    if (!(await this.deps.organizations.slugExists(base))) return base;
    for (let i = 2; i < 50; i += 1) {
      const candidate = `${base}-${i}`;
      if (!(await this.deps.organizations.slugExists(candidate))) return candidate;
    }
    return `${base}-${newId().slice(-6)}`;
  }
}
