import { AppError, conflict, notFound, validationError } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import {
  assertAcceptablePassword,
  isSessionActive,
  normalizeEmail,
  PASSWORD_RESET_TTL_MS,
  sessionExpiry,
  shouldTouchSession,
  type User,
} from '../domain/identity-rules';
import type {
  CredentialRepository,
  PasswordHasher,
  PasswordResetRepository,
  SessionRepository,
  TokenService,
  UserRegisteredHook,
  UserRepository,
} from './ports';

export interface IdentityDeps {
  users: UserRepository;
  credentials: CredentialRepository;
  sessions: SessionRepository;
  resets: PasswordResetRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  tx: TransactionRunner;
  clock: Clock;
  jobs: BackgroundJobs;
  appUrl: string;
  onUserRegistered: UserRegisteredHook[];
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface AuthenticatedSession {
  user: User;
  session: { id: string; expiresAt: Date };
}

/**
 * A hash of a random password, verified when the email is unknown so that "no such user"
 * and "wrong password" take the same time (no account enumeration by timing).
 */
let dummyHash: Promise<string> | null = null;

export class IdentityUseCases {
  constructor(private readonly deps: IdentityDeps) {}

  async register(
    input: { name: string; email: string; password: string },
    meta: ClientMeta,
  ): Promise<{ user: User; session: IssuedSession }> {
    const { users, credentials, tx, clock, hasher, onUserRegistered } = this.deps;
    const email = normalizeEmail(input.email);
    assertAcceptablePassword(input.password, { email });
    // Hash before opening the transaction: argon2 is deliberately slow.
    const passwordHash = await hasher.hash(input.password);

    return tx.run(async () => {
      if (await users.findByEmail(email)) {
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      const now = clock.now();
      const user: User = {
        id: newId(now.getTime()),
        email,
        name: input.name.trim(),
        avatarUrl: null,
        createdAt: now,
        updatedAt: now,
      };
      await users.create(user);
      await credentials.setPasswordHash(user.id, passwordHash, now);
      await credentials.linkIdentity(user.id, 'password', email, now);
      for (const hook of onUserRegistered) await hook(user);
      const session = await this.issueSession(user.id, meta);
      return { user, session };
    });
  }

  async logIn(
    input: { email: string; password: string },
    meta: ClientMeta,
  ): Promise<{ user: User; session: IssuedSession }> {
    const { users, credentials, hasher } = this.deps;
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      throw this.invalidCredentials();
    }
    const user = await users.findByEmail(email);
    const passwordHash = user ? await credentials.getPasswordHash(user.id) : null;
    if (!user || !passwordHash) {
      dummyHash ??= hasher.hash(`dummy-${newId()}`);
      await hasher.verify(await dummyHash, input.password);
      throw this.invalidCredentials();
    }
    if (!(await hasher.verify(passwordHash, input.password))) throw this.invalidCredentials();
    const session = await this.issueSession(user.id, meta);
    return { user, session };
  }

  async logOut(sessionId: string): Promise<void> {
    await this.deps.sessions.revoke(sessionId, this.deps.clock.now());
  }

  /** Resolves a session cookie. Returns null for unknown, revoked or expired sessions. */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const { sessions, tokens, clock } = this.deps;
    if (token.length < 20 || token.length > 200) return null;
    const record = await sessions.findByTokenHash(tokens.hash(token));
    const now = clock.now();
    if (!record || !isSessionActive(record, now)) return null;
    let expiresAt = record.expiresAt;
    if (shouldTouchSession(record.lastSeenAt, now)) {
      expiresAt = sessionExpiry(record.createdAt, now);
      await sessions.touch(record.id, now, expiresAt);
    }
    return { user: record.user, session: { id: record.id, expiresAt } };
  }

  async getUser(userId: string): Promise<User> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
    return user;
  }

  async updateProfile(
    actor: Actor,
    patch: { name?: string; avatarUrl?: string | null },
  ): Promise<User> {
    return this.deps.users.updateProfile(actor.userId, patch, this.deps.clock.now());
  }

  /** Changing a password signs out every other session (a stolen session dies with the old password). */
  async changePassword(
    actor: Actor,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const { credentials, hasher, sessions, tx, clock } = this.deps;
    const user = await this.getUser(actor.userId);
    const currentHash = await credentials.getPasswordHash(user.id);
    if (!currentHash || !(await hasher.verify(currentHash, input.currentPassword))) {
      throw validationError('CURRENT_PASSWORD_INCORRECT', 'Your current password is incorrect', [
        { path: 'currentPassword', message: 'Incorrect password' },
      ]);
    }
    if (input.currentPassword === input.newPassword) {
      throw validationError(
        'PASSWORD_UNCHANGED',
        'Choose a password different from the current one',
      );
    }
    assertAcceptablePassword(input.newPassword, { email: user.email });
    const newHash = await hasher.hash(input.newPassword);
    await tx.run(async () => {
      const now = clock.now();
      await credentials.setPasswordHash(user.id, newHash, now);
      await sessions.revokeAllForUser(user.id, now, actor.sessionId ?? undefined);
    });
  }

  /**
   * Always succeeds from the caller's point of view, whether or not the email exists,
   * so the endpoint cannot be used to discover accounts.
   */
  async requestPasswordReset(input: { email: string }): Promise<void> {
    const { users, credentials, resets, tokens, tx, clock, jobs, appUrl } = this.deps;
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      return;
    }
    const user = await users.findByEmail(email);
    if (!user || !(await credentials.getPasswordHash(user.id))) return;
    const token = tokens.generate();
    await tx.run(async () => {
      const now = clock.now();
      await resets.invalidateAllForUser(user.id, now);
      await resets.create({
        id: newId(),
        userId: user.id,
        tokenHash: tokens.hash(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      });
      const link = `${appUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
      await jobs.enqueue('email.send', {
        to: user.email,
        subject: 'Reset your AgentForge password',
        text:
          `Hi ${user.name},\n\nSomeone asked to reset the password for your AgentForge account.\n` +
          `Open this link within 30 minutes to choose a new one:\n\n${link}\n\n` +
          `If it wasn't you, ignore this email; your password stays the same.\n`,
      });
    });
  }

  async resetPassword(input: { token: string; newPassword: string }): Promise<void> {
    const { resets, tokens, users, credentials, sessions, hasher, tx, clock } = this.deps;
    const record = await resets.findByTokenHash(tokens.hash(input.token));
    const now = clock.now();
    if (!record || record.usedAt || record.expiresAt <= now) {
      throw validationError('RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
    }
    const user = await users.findById(record.userId);
    if (!user)
      throw validationError('RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
    assertAcceptablePassword(input.newPassword, { email: user.email });
    const newHash = await hasher.hash(input.newPassword);
    await tx.run(async () => {
      if (!(await resets.markUsed(record.id, now))) {
        throw validationError('RESET_TOKEN_INVALID', 'This reset link was already used');
      }
      await credentials.setPasswordHash(user.id, newHash, now);
      await sessions.revokeAllForUser(user.id, now);
    });
  }

  private async issueSession(userId: string, meta: ClientMeta): Promise<IssuedSession> {
    const { sessions, tokens, clock } = this.deps;
    const now = clock.now();
    const token = tokens.generate();
    const session = {
      id: newId(now.getTime()),
      userId,
      tokenHash: tokens.hash(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: sessionExpiry(now, now),
      revokedAt: null,
      ip: meta.ip,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
    };
    await sessions.create(session);
    return { id: session.id, token, expiresAt: session.expiresAt };
  }

  private invalidCredentials(): AppError {
    return new AppError('unauthenticated', 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
}
