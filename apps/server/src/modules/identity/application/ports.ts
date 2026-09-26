import type { User } from '../domain/identity-rules';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Throws conflict EMAIL_TAKEN when the email is already registered. */
  create(user: User): Promise<void>;
  updateProfile(
    id: string,
    patch: { name?: string; avatarUrl?: string | null },
    now: Date,
  ): Promise<User>;
}

export interface CredentialRepository {
  getPasswordHash(userId: string): Promise<string | null>;
  setPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void>;
  linkIdentity(
    userId: string,
    provider: 'password' | 'github' | 'google',
    subject: string,
    now: Date,
  ): Promise<void>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionRepository {
  create(session: SessionRecord & { ip: string | null; userAgent: string | null }): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: User }) | null>;
  touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<void>;
  revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number>;
}

export interface PasswordResetRepository {
  create(token: {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  findByTokenHash(
    tokenHash: string,
  ): Promise<{ id: string; userId: string; expiresAt: Date; usedAt: Date | null } | null>;
  /** Conditional update: true only for the call that actually consumed the token. */
  markUsed(id: string, now: Date): Promise<boolean>;
  invalidateAllForUser(userId: string, now: Date): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/** High-entropy bearer tokens (session cookies, reset links); only hashes are stored. */
export interface TokenService {
  generate(): string;
  hash(token: string): string;
}

/**
 * Called inside the registration transaction. The organizations module implements it to
 * create the new user's personal organization; identity never imports organizations.
 */
export type UserRegisteredHook = (user: User) => Promise<void>;
