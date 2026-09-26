import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  authIdentities,
  passwordCredentials,
  passwordResetTokens,
  sessions,
  users,
} from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { isUniqueViolation } from '../../../platform/database/errors';
import { executor } from '../../../platform/database/transaction';
import { conflict, notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { User } from '../domain/identity-rules';
import type {
  CredentialRepository,
  PasswordResetRepository,
  SessionRecord,
  SessionRepository,
  UserRepository,
} from '../application/ports';

type UserRow = typeof users.$inferSelect;
const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  avatarUrl: row.avatarUrl,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | null> {
    const [row] = await executor(this.db).select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await executor(this.db)
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return row ? toUser(row) : null;
  }

  async create(user: User): Promise<void> {
    try {
      await executor(this.db).insert(users).values(user);
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw error;
    }
  }

  async updateProfile(
    id: string,
    patch: { name?: string; avatarUrl?: string | null },
    now: Date,
  ): Promise<User> {
    const values: Partial<typeof users.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.avatarUrl !== undefined) values.avatarUrl = patch.avatarUrl;
    const [row] = await executor(this.db)
      .update(users)
      .set(values)
      .where(eq(users.id, id))
      .returning();
    if (!row) throw notFound('USER_NOT_FOUND', 'User not found');
    return toUser(row);
  }
}

export class DrizzleCredentialRepository implements CredentialRepository {
  constructor(private readonly db: Database) {}

  async getPasswordHash(userId: string): Promise<string | null> {
    const [row] = await executor(this.db)
      .select({ hash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId))
      .limit(1);
    return row?.hash ?? null;
  }

  async setPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    await executor(this.db)
      .insert(passwordCredentials)
      .values({ userId, passwordHash, updatedAt: now })
      .onConflictDoUpdate({
        target: passwordCredentials.userId,
        set: { passwordHash, updatedAt: now },
      });
  }

  async linkIdentity(
    userId: string,
    provider: 'password' | 'github' | 'google',
    subject: string,
    now: Date,
  ) {
    await executor(this.db)
      .insert(authIdentities)
      .values({
        id: newId(now.getTime()),
        userId,
        provider,
        providerSubject: subject,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async create(
    session: SessionRecord & { ip: string | null; userAgent: string | null },
  ): Promise<void> {
    await executor(this.db).insert(sessions).values(session);
  }

  async findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: User }) | null> {
    const [row] = await executor(this.db)
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    const s = row.session;
    return {
      id: s.id,
      userId: s.userId,
      tokenHash: s.tokenHash,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      user: toUser(row.user),
    };
  }

  async touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    await executor(this.db)
      .update(sessions)
      .set({ lastSeenAt, expiresAt })
      .where(eq(sessions.id, id));
  }

  async revoke(id: string, now: Date): Promise<void> {
    await executor(this.db)
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number> {
    const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
    const rows = await executor(this.db)
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(...conditions))
      .returning({ id: sessions.id });
    return rows.length;
  }
}

export class DrizzlePasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly db: Database) {}

  async create(token: {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }) {
    await executor(this.db).insert(passwordResetTokens).values(token);
  }

  async findByTokenHash(tokenHash: string) {
    const [row] = await executor(this.db)
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    return row
      ? { id: row.id, userId: row.userId, expiresAt: row.expiresAt, usedAt: row.usedAt }
      : null;
  }

  async markUsed(id: string, now: Date): Promise<boolean> {
    const rows = await executor(this.db)
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    return rows.length === 1;
  }

  async invalidateAllForUser(userId: string, now: Date): Promise<void> {
    await executor(this.db)
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  }
}
