import { hash, verify } from '@node-rs/argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/**
 * Argon2id with OWASP's baseline parameters (19 MiB memory, 2 iterations, 1 lane).
 * The encoded hash stores its own parameters, so raising them later still verifies old hashes.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly options = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }) {}

  hash(password: string): Promise<string> {
    // @node-rs/argon2 defaults to Argon2id.
    return hash(password, { ...this.options });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}

/** Cheap parameters for tests only: the algorithm is the same, the cost is not. */
export const testPasswordHasher = () =>
  new Argon2PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
