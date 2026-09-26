import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer secrets (session cookies, password-reset links): 256 random bits, base64url.
 * Only the SHA-256 is stored, so a leaked database does not leak usable tokens.
 * A plain hash (not argon2) is right here: the input is already high-entropy.
 */
export interface SecureTokens {
  generate(): string;
  hash(token: string): string;
}

export const secureTokens: SecureTokens = {
  generate: () => randomBytes(32).toString('base64url'),
  hash: (token: string) => createHash('sha256').update(token, 'utf8').digest('hex'),
};

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
