import 'server-only';
import { z } from 'zod';

// Server env, parsed with zod on first access (never at import, so `next build` works without secrets).
// Every var from .env.example is listed. Empty strings count as "not set".

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

const base64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
});

export const DEFAULT_REPO_CACHE_DIR = './.cache/repos';

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PUBLIC_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    BETTER_AUTH_URL: z.url(),
    GITHUB_APP_ID: optional(z.string()),
    GITHUB_APP_PRIVATE_KEY: optional(z.string()),
    GITHUB_WEBHOOK_SECRET: optional(z.string()),
    GITHUB_CLIENT_ID: optional(z.string()),
    GITHUB_CLIENT_SECRET: optional(z.string()),
    INNGEST_EVENT_KEY: optional(z.string()),
    INNGEST_SIGNING_KEY: optional(z.string()),
    INNGEST_BASE_URL: optional(z.url()),
    INNGEST_DEV: optional(z.string()),
    ENCRYPTION_KEY: optional(base64Key32),
    ANTHROPIC_API_KEY: optional(z.string()),
    OPENAI_API_KEY: optional(z.string()),
    CHATGPT_OAUTH_CLIENT_ID: optional(z.string()),
    CHATGPT_OAUTH_CLIENT_SECRET: optional(z.string()),
    /** Commits-only clones for the branch tree (tasks/T-branch-tree.md). */
    REPO_CACHE_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_REPO_CACHE_DIR)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Optional in dev, required to run in production.
    const required = [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'ENCRYPTION_KEY',
    ] as const;
    for (const key of required) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Parses an env source. Throws listing only variable names + reasons — never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`Invalid environment variables:\n${lines.join('\n')}`);
}

const skipValidation = () =>
  !!process.env.SKIP_ENV_VALIDATION || process.env.NEXT_PHASE === 'phase-production-build';

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  try {
    cached = parseEnv(process.env);
  } catch (err) {
    if (!skipValidation()) throw err;
    // Build / tests: fall back to raw values so imports don't crash.
    cached = process.env as unknown as Env;
  }
  return cached;
}

/** Test helper: forget the cached env. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Lazily-parsed env: `env.DATABASE_URL`. */
export const env: Env = new Proxy({} as Env, {
  get: (_target, key) => getEnv()[key as keyof Env],
});
