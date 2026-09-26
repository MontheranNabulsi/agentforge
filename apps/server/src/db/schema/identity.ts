import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, sqlList, ts, updatedAt } from './columns';

export const users = pgTable(
  'users',
  {
    id: idColumn(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('users_email_lowercase', sql`${t.email} = lower(${t.email})`)],
);

/** Only users who sign in with a password have a row here. */
export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  updatedAt: updatedAt(),
});

export const AUTH_PROVIDERS = ['password', 'github', 'google'] as const;

/**
 * How a person proves who they are. Separating identities from users is what lets
 * OAuth arrive later as new rows (provider = 'github') instead of a schema rewrite.
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auth_identities_provider_subject_unique').on(t.provider, t.providerSubject),
    index('auth_identities_user_idx').on(t.userId),
    check('auth_identities_provider_check', sql.raw(`provider IN ${sqlList(AUTH_PROVIDERS)}`)),
  ],
);

/** Server-side sessions. Only a SHA-256 of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId)],
);
