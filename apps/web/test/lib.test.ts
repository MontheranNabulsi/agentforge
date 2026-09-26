import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { bytes, compact, duration, initials, percent } from '@/lib/format';

describe('formatting', () => {
  it('formats durations, sizes and numbers for humans', () => {
    expect(duration(850)).toBe('850 ms');
    expect(duration(2_345)).toBe('2.35 s');
    expect(duration(95_000)).toBe('1m 35s');
    expect(duration(null)).toBe('—');
    expect(bytes(2048)).toBe('2.0 KB');
    expect(compact(23_100)).toBe('23.1K');
    expect(percent(0.666)).toBe('67%');
    expect(initials('Alex  Rivera')).toBe('AR');
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns problem details into ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            status: 409,
            code: 'RUN_IN_PROGRESS',
            title: 'Conflict',
            detail: 'Still working',
            type: 'about:blank',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );
    const error = await api('/conversations/x/messages', { body: { content: 'hi' } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'RUN_IN_PROGRESS', message: 'Still working' });
  });

  it('sends JSON with the session cookie and handles 204', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 204 });
    });
    await expect(api('/auth/logout', { method: 'POST', body: {} })).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });
});
