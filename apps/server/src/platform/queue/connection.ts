import { Redis } from 'ioredis';

/**
 * BullMQ needs `maxRetriesPerRequest: null` so blocking commands wait for Redis to come
 * back instead of failing the worker loop. The same client options work for caches and
 * rate limiting.
 */
export function createRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName,
    lazyConnect: false,
  });
}
