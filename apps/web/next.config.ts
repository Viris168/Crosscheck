import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Env: one .env at the repo root, loaded by `dotenv -e ../../.env` in the dev/build scripts
// (Next only reads .env files from apps/web itself). In Docker, compose injects the env.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@app/shared', '@app/db'],
  // Keep native/server-only libs out of the bundle.
  serverExternalPackages: ['@prisma/client', '.prisma/client', 'ioredis', 'pino'],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // Dev only: let `next dev` serve its client/HMR resources through a Cloudflare quick tunnel
  // (docs/deploy.md 1.4). Ignored by `next build` / production.
  allowedDevOrigins: ['*.trycloudflare.com'],
};

export default nextConfig;
