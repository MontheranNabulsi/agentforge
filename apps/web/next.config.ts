import type { NextConfig } from 'next';

/**
 * In production the web app is served by the API process (one origin), so /api needs no proxy.
 * For split local development (`pnpm --filter web dev` next to the API on :4000) set
 * API_ORIGIN=http://localhost:4000 and /api, /docs and /health are forwarded to it.
 */
const apiOrigin = process.env.API_ORIGIN;

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Streaming responses (server-sent events) must not be buffered for compression.
  compress: false,
  transpilePackages: ['@agentforge/contracts'],
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    if (!apiOrigin) return [];
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/docs/:path*', destination: `${apiOrigin}/docs/:path*` },
      { source: '/health/:path*', destination: `${apiOrigin}/health/:path*` },
    ];
  },
};

export default config;
