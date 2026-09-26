import type { Role } from '../domain/access-rules';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

export interface OrganizationRepository {
  create(organization: Organization): Promise<void>;
  findById(id: string): Promise<Organization | null>;
  slugExists(slug: string): Promise<boolean>;
  listForUser(userId: string): Promise<(Organization & { role: Role })[]>;
}

export interface MembershipRepository {
  add(organizationId: string, userId: string, role: Role, now: Date): Promise<void>;
  findRole(organizationId: string, userId: string): Promise<Role | null>;
  list(organizationId: string): Promise<MemberView[]>;
  countOwners(organizationId: string): Promise<number>;
  updateRole(organizationId: string, userId: string, role: Role): Promise<void>;
  remove(organizationId: string, userId: string): Promise<void>;
}
