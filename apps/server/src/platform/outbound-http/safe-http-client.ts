import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request, type Dispatcher } from 'undici';

/**
 * Outbound HTTP for agent tools, built against SSRF (server-side request forgery).
 *
 * A model can be talked into requesting any URL ("fetch http://169.254.169.254/…"), so every
 * request is checked here, in code, before a socket opens:
 *   1. scheme must be https (http only when explicitly enabled for local development);
 *   2. the host must be on the agent's allowlist (exact name or "*.example.com");
 *   3. the name is resolved once and EVERY address must be public unicast: loopback, private,
 *      link-local (cloud metadata), CGNAT, multicast and reserved ranges are refused;
 *   4. the connection is pinned to the address that was checked (no second DNS lookup, so a
 *      rebinding DNS server cannot swap in 127.0.0.1 between check and connect);
 *   5. redirects are followed manually and each hop is checked again from step 1;
 *   6. time and response size are capped; no cookies or credentials are ever attached.
 *
 * Known limits (documented in docs/security.md): an allowlisted host that is itself
 * compromised can still return hostile content, which is why tool output is treated as
 * untrusted data by the prompts and never executed.
 */

export class OutboundRequestBlocked extends Error {
  constructor(
    readonly code:
      | 'SCHEME_NOT_ALLOWED'
      | 'HOST_NOT_ALLOWED'
      | 'ADDRESS_NOT_ALLOWED'
      | 'METHOD_NOT_ALLOWED'
      | 'TOO_MANY_REDIRECTS'
      | 'INVALID_URL',
    message: string,
  ) {
    super(message);
    this.name = 'OutboundRequestBlocked';
  }
}

export interface OutboundPolicy {
  allowedHosts: string[];
  allowWrite: boolean;
}

export interface OutboundResponse {
  status: number;
  url: string;
  contentType: string | null;
  body: unknown;
  truncated: boolean;
}

export interface SafeHttpClientOptions {
  allowHttp?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** Test seam: resolve names without real DNS. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((entry) => {
    const pattern = entry.toLowerCase().trim();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export class SafeHttpClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly resolve: (hostname: string) => Promise<{ address: string; family: number }[]>;

  constructor(private readonly options: SafeHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxResponseBytes ?? 256 * 1024;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.resolve =
      options.resolve ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  }

  async request(
    input: { method: string; url: string; body?: unknown },
    policy: OutboundPolicy,
    signal?: AbortSignal,
  ): Promise<OutboundResponse> {
    const method = input.method.toUpperCase();
    if (WRITE_METHODS.has(method) && !policy.allowWrite) {
      throw new OutboundRequestBlocked(
        'METHOD_NOT_ALLOWED',
        `This agent may only send GET requests (${method} is not enabled)`,
      );
    }
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let url = this.parse(input.url);
    let currentMethod = method;
    let body: string | undefined =
      input.body === undefined || method === 'GET' ? undefined : JSON.stringify(input.body);

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const target = await this.vet(url, policy);
      const agent = this.pinnedAgent(target.address, target.family);
      try {
        const response = await request(url, {
          method: currentMethod as Dispatcher.HttpMethod,
          dispatcher: agent,
          signal: combined,
          headers: {
            'user-agent': 'AgentForge-Agent/1.0 (+https://github.com/MontheranNabulsi/agentforge)',
            accept: 'application/json, text/plain;q=0.9, text/*;q=0.8',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body } : {}),
        });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          await response.body.dump();
          const location = response.headers.location;
          const next = Array.isArray(location) ? location[0] : location;
          if (!next)
            throw new OutboundRequestBlocked('INVALID_URL', 'Redirect without a Location header');
          url = this.parse(new URL(next, url).toString());
          if (
            response.statusCode === 303 ||
            ((response.statusCode === 301 || response.statusCode === 302) &&
              currentMethod === 'POST')
          ) {
            currentMethod = 'GET';
            body = undefined;
          }
          continue;
        }
        const contentType = headerValue(response.headers['content-type']);
        const { bytes, truncated } = await readCapped(response.body, this.maxBytes);
        return {
          status: response.statusCode,
          url: url.toString(),
          contentType,
          body: decodeBody(bytes, contentType, truncated),
          truncated,
        };
      } finally {
        await agent.close().catch(() => undefined);
      }
    }
    throw new OutboundRequestBlocked(
      'TOO_MANY_REDIRECTS',
      `More than ${this.maxRedirects} redirects`,
    );
  }

  private parse(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new OutboundRequestBlocked('INVALID_URL', 'The URL is not valid');
    }
    const schemeOk =
      url.protocol === 'https:' || (this.options.allowHttp === true && url.protocol === 'http:');
    if (!schemeOk)
      throw new OutboundRequestBlocked(
        'SCHEME_NOT_ALLOWED',
        `Only https URLs are allowed (got ${url.protocol})`,
      );
    if (url.username || url.password)
      throw new OutboundRequestBlocked('INVALID_URL', 'URLs with credentials are not allowed');
    return url;
  }

  private async vet(
    url: URL,
    policy: OutboundPolicy,
  ): Promise<{ address: string; family: number }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostAllowed(hostname, policy.allowedHosts)) {
      throw new OutboundRequestBlocked(
        'HOST_NOT_ALLOWED',
        policy.allowedHosts.length === 0
          ? 'This agent has no allowed hosts for HTTP requests'
          : `${hostname} is not on this agent's allowlist (${policy.allowedHosts.join(', ')})`,
      );
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolve(hostname);
    if (addresses.length === 0)
      throw new OutboundRequestBlocked('ADDRESS_NOT_ALLOWED', `${hostname} did not resolve`);
    for (const entry of addresses) {
      if (!isPublicAddress(entry.address)) {
        throw new OutboundRequestBlocked(
          'ADDRESS_NOT_ALLOWED',
          `${hostname} resolves to a non-public address`,
        );
      }
    }
    return addresses[0]!;
  }

  /** An undici Agent whose sockets can only connect to the address that passed vetting. */
  private pinnedAgent(address: string, family: number): Agent {
    return new Agent({
      connect: {
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      } as Record<string, unknown>,
      connections: 1,
      pipelining: 0,
    });
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function readCapped(
  stream: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
) {
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const piece = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    if (size + piece.length > maxBytes) {
      parts.push(piece.subarray(0, maxBytes - size));
      truncated = true;
      stream.destroy?.();
      break;
    }
    parts.push(piece);
    size += piece.length;
  }
  return { bytes: Buffer.concat(parts), truncated };
}

function decodeBody(bytes: Buffer, contentType: string | null, truncated: boolean): unknown {
  const type = (contentType ?? '').toLowerCase();
  const textual =
    type.includes('json') || type.startsWith('text/') || type.includes('xml') || type === '';
  if (!textual) return `[${bytes.length} bytes of ${contentType} omitted]`;
  const text = bytes.toString('utf8');
  if (type.includes('json') && !truncated) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}
