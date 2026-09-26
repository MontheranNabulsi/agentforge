import { and, asc, count, eq } from 'drizzle-orm';
import { organizationMembers, organizations, users } from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { isUniqueViolation } from '../../../platform/database/errors';
import { executor } from '../../../platform/database/transaction';
import { conflict } from '../../../shared-kernel/errors';
import { isRole, type Role } from '../domain/access-rules';
import type {
  MembershipRepository,
  MemberView,
  Organization,
  OrganizationRepository,
} from '../application/ports';

const asRole = (value: string): Role => (isRole(value) ? value : 'viewer');

export class DrizzleOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: Database) {}

  async create(organization: Organization): Promise<void> {
    try {
      await executor(this.db).insert(organizations).values(organization);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('SLUG_TAKEN', 'That organization URL is taken');
      throw error;
    }
  }

  async findById(id: string): Promise<Organization | null> {
    const [row] = await executor(this.db)
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return row ?? null;
  }

  async slugExists(slug: string): Promise<boolean> {
    const [row] = await executor(this.db)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return Boolean(row);
  }

  async listForUser(userId: string): Promise<(Organization & { role: Role })[]> {
    const rows = await executor(this.db)
      .select({ organization: organizations, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.createdAt));
    return rows.map((r) => ({ ...r.organization, role: asRole(r.role) }));
  }
}

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async add(organizationId: string, userId: string, role: Role, now: Date): Promise<void> {
    await executor(this.db)
      .insert(organizationMembers)
      .values({ organizationId, userId, role, createdAt: now })
      .onConflictDoNothing();
  }

  async findRole(organizationId: string, userId: string): Promise<Role | null> {
    const [row] = await executor(this.db)
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row ? asRole(row.role) : null;
  }

  async list(organizationId: string): Promise<MemberView[]> {
    const rows = await executor(this.db)
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: organizationMembers.role,
        joinedAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId))
      .orderBy(asc(organizationMembers.createdAt));
    return rows.map((r) => ({ ...r, role: asRole(r.role) }));
  }

  async countOwners(organizationId: string): Promise<number> {
    const [row] = await executor(this.db)
      .select({ value: count() })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.role, 'owner'),
        ),
      );
    return row?.value ?? 0;
  }

  async updateRole(organizationId: string, userId: string, role: Role): Promise<void> {
    await executor(this.db)
      .update(organizationMembers)
      .set({ role })
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );
  }

  async remove(organizationId: string, userId: string): Promise<void> {
    await executor(this.db)
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );
  }
}
