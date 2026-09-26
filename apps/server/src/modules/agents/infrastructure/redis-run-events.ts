import type { RunEvent } from '@agentforge/contracts';
import type { Redis } from 'ioredis';
import type { RunEventPublisher, RunEventReader } from '../application/ports';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Redis Stream per run. The worker appends; any API instance can replay the stream from
 * any point, so a browser that reconnects (Last-Event-ID) resumes exactly where it stopped and
 * the API and worker can run on different machines.
 *
 * Reads poll with XRANGE on the shared connection instead of a blocking XREAD: a blocking read
 * would need one Redis connection per open browser tab, and free-tier Redis caps connections.
 */
export class RedisRunEvents implements RunEventPublisher, RunEventReader {
  constructor(
    private readonly redis: Redis,
    private readonly options: {
      prefix?: string;
      maxLength?: number;
      retainSeconds?: number;
      pollMs?: number;
    } = {},
  ) {}

  private key(runId: string): string {
    return `${this.options.prefix ?? 'agentforge:run-events:'}${runId}`;
  }

  async publish(runId: string, event: RunEvent): Promise<void> {
    await this.redis.xadd(
      this.key(runId),
      'MAXLEN',
      '~',
      String(this.options.maxLength ?? 5_000),
      '*',
      'e',
      JSON.stringify(event),
    );
  }

  async expireLater(runId: string): Promise<void> {
    await this.redis.expire(this.key(runId), this.options.retainSeconds ?? 3_600);
  }

  async read(
    runId: string,
    afterId: string | null,
    blockMs: number,
  ): Promise<{ id: string; event: RunEvent }[]> {
    const started = Date.now();
    for (;;) {
      const entries = await this.redis.xrange(
        this.key(runId),
        afterId ? `(${afterId}` : '-',
        '+',
        'COUNT',
        500,
      );
      if (entries.length > 0 || Date.now() - started >= blockMs) {
        return entries.flatMap(([id, fields]) => {
          const index = fields.indexOf('e');
          if (index < 0 || fields[index + 1] === undefined) return [];
          try {
            return [{ id, event: JSON.parse(fields[index + 1]!) as RunEvent }];
          } catch {
            return [];
          }
        });
      }
      await sleep(this.options.pollMs ?? 100);
    }
  }
}
