import { forbidden, notFound } from '../../../shared-kernel/errors';
import type { Actor } from '../../../shared-kernel/ports';
import { can, type Permission, type Role } from '../domain/access-rules';
import type { MembershipRepository, Organization, OrganizationRepository } from './ports';

export interface OrganizationAccessGrant {
  organization: Organization;
  role: Role;
}

/**
 * The tenant boundary. Every organization-scoped use case starts here.
 *
 * Not a member → 404 (the organization's existence is not revealed).
 * Member without the permission → 403 (they can see it, but not do this).
 */
export class OrganizationAccess {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  async require(
    actor: Actor,
    organizationId: string,
    permission: Permission,
  ): Promise<OrganizationAccessGrant> {
    const role = await this.memberships.findRole(organizationId, actor.userId);
    const organization = role ? await this.organizations.findById(organizationId) : null;
    if (!role || !organization) throw notFound('ORGANIZATION_NOT_FOUND', 'Organization not found');
    if (!can(role, permission)) {
      throw forbidden(
        'PERMISSION_DENIED',
        `Your role (${role}) cannot ${permission.replace(':', ' ')}`,
      );
    }
    return { organization, role };
  }

  /** Role lookup without throwing, for read models that adapt to the viewer. */
  roleOf(actor: Actor, organizationId: string): Promise<Role | null> {
    return this.memberships.findRole(organizationId, actor.userId);
  }
}
