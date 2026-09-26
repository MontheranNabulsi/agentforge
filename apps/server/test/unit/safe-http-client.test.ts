import { describe, expect, it } from 'vitest';
import {
  hostAllowed,
  isPublicAddress,
  SafeHttpClient,
} from '../../src/platform/outbound-http/safe-http-client';

describe('outbound HTTP guard (SSRF)', () => {
  it('matches exact hosts and wildcard subdomains only', () => {
    expect(hostAllowed('api.github.com', ['api.github.com'])).toBe(true);
    expect(hostAllowed('API.GitHub.com.', ['api.github.com'])).toBe(true);
    expect(hostAllowed('evil-api.github.com', ['api.github.com'])).toBe(false);
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.io', ['*.example.com'])).toBe(false);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
  ])('treats %s as non-public', (address) => expect(isPublicAddress(address)).toBe(false));

  it('treats ordinary internet addresses as public', () => {
    expect(isPublicAddress('140.82.112.5')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  const policy = { allowedHosts: ['api.example.com', 'rebind.example.com'], allowWrite: false };

  it('refuses hosts outside the allowlist before any network access', async () => {
    const client = new SafeHttpClient({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(
      client.request({ method: 'GET', url: 'https://other.example.org/x' }, policy),
    ).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
  });

  it('refuses allowlisted names that resolve to private addresses (DNS rebinding, metadata endpoints)', async () => {
    const client = new SafeHttpClient({
      resolve: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    await expect(
      client.request({ method: 'GET', url: 'https://rebind.example.com/latest/meta-data' }, policy),
    ).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('refuses plain http, credentials in URLs and writes without permission', async () => {
    const client = new SafeHttpClient({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(
      client.request({ method: 'GET', url: 'http://api.example.com/' }, policy),
    ).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
    await expect(
      client.request({ method: 'GET', url: 'https://user:pw@api.example.com/' }, policy),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    await expect(
      client.request({ method: 'POST', url: 'https://api.example.com/', body: {} }, policy),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  });
});
