import { validationError } from '../../../shared-kernel/errors';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails are compared case-insensitively, so they are stored lower-cased (a CHECK enforces it). */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw validationError('INVALID_EMAIL', 'Enter a valid email address', [
      { path: 'email', message: 'Enter a valid email address' },
    ]);
  }
  return email;
}

// ---------------------------------------------------------------------------------------
// Passwords (NIST SP 800-63B style: length over composition rules, block the obvious)
// ---------------------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'qwerty12345',
  'letmein1234',
  'iloveyou123',
  'administrator',
  'welcome1234',
  'passw0rd123',
  'agentforge123',
]);

export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters`);
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('This password is too common');
  if (/^(.)\1+$/.test(password)) problems.push('Avoid repeating a single character');
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    problems.push("Don't include your email address in your password");
  }
  return problems;
}

export function assertAcceptablePassword(password: string, context: { email?: string } = {}): void {
  const problems = passwordProblems(password, context);
  if (problems.length > 0) {
    throw validationError(
      'WEAK_PASSWORD',
      problems[0]!,
      problems.map((message) => ({ path: 'password', message })),
    );
  }
}

// ---------------------------------------------------------------------------------------
// Sessions: sliding idle timeout, capped by an absolute lifetime
// ---------------------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SESSION_IDLE_TIMEOUT_MS = 7 * DAY;
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * DAY;
/** Only write last_seen_at at most hourly, so reads don't turn into writes on every request. */
export const SESSION_TOUCH_INTERVAL_MS = HOUR;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export function sessionExpiry(createdAt: Date, now: Date): Date {
  return new Date(
    Math.min(
      now.getTime() + SESSION_IDLE_TIMEOUT_MS,
      createdAt.getTime() + SESSION_ABSOLUTE_LIFETIME_MS,
    ),
  );
}

export function isSessionActive(
  session: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

export function shouldTouchSession(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}
