import type { Redis } from 'ioredis';

/**
 * Cache-aside over Redis for read models that are expensive to compute and fine to serve
 * slightly stale (dashboards) or that are deterministic (query embeddings).
 *
 * Failure policy: the cache is an optimization. If Redis is down we compute and move on;
 * a cache outage must never become an application outage.
 */
export interface JsonCache {
  remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class RedisJsonCache implements JsonCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'agentforge-cache:',
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.prefix + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // best effort
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(this.prefix + key);
    } catch {
      // best effort
    }
  }

  async remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

/** For tests and for running without Redis. */
export class MemoryJsonCache implements JsonCache {
  private readonly store = new Map<string, { value: string; expires: number }>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit || hit.expires < Date.now()) return null;
    return JSON.parse(hit.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value: JSON.stringify(value), expires: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}
