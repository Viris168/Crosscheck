import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit as RestOctokit } from '@octokit/rest';

/** Octokit with REST endpoint methods + retry + throttling. */
export const Octokit = RestOctokit.plugin(retry, throttling);
export type Octokit = InstanceType<typeof Octokit>;

type OctokitOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>;

/** Max automatic retries when GitHub rate-limits us (primary or secondary). */
const MAX_RATE_LIMIT_RETRIES = 2;

// VERIFY: throttle handler signature `(retryAfter, options, octokit, retryCount)` for
//         @octokit/plugin-throttling v11.
const throttle = {
  onRateLimit: (_retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
    retryCount < MAX_RATE_LIMIT_RETRIES,
  onSecondaryRateLimit: (
    _retryAfter: number,
    _options: unknown,
    _octokit: unknown,
    retryCount: number,
  ) => retryCount < MAX_RATE_LIMIT_RETRIES,
};

/** Builds an Octokit with our defaults (retry + throttling). Extra options win. */
export function createOctokit(options: OctokitOptions = {}): Octokit {
  return new Octokit({
    userAgent: 'ai-code-review-app',
    throttle,
    ...options,
  });
}

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
}

/**
 * Reads GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY from the environment. The private key may be stored
 * with literal `\n` escapes (single-line .env); they are turned back into newlines.
 */
export function readAppCredentials(
  source: Record<string, string | undefined> = process.env,
): GithubAppCredentials {
  const appId = source.GITHUB_APP_ID?.trim();
  const privateKey = source.GITHUB_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set');
  }
  return { appId, privateKey };
}

// ---------------------------------------------------------------- app + installation clients

let appOctokit: Octokit | undefined;

/** Octokit authenticated as the GitHub App itself (JWT). For /app/* endpoints. */
export function getAppOctokit(): Octokit {
  if (appOctokit) return appOctokit;
  const { appId, privateKey } = readAppCredentials();
  appOctokit = createOctokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  return appOctokit;
}

/** Refresh installation tokens this long before GitHub says they expire. */
const EXPIRY_SKEW_MS = 5 * 60_000;

interface CachedInstallation {
  octokit: Promise<Octokit>;
  /** epoch ms; Infinity while the token request is in flight. */
  expiresAt: number;
}

const installationCache = new Map<number, CachedInstallation>();

type InstallationAuth = (opts: {
  type: 'installation';
  installationId: number;
}) => Promise<{ token: string; expiresAt: string }>;

let appAuth: InstallationAuth | undefined;

function getAppAuth(): InstallationAuth {
  if (!appAuth) {
    const { appId, privateKey } = readAppCredentials();
    appAuth = createAppAuth({ appId, privateKey }) as unknown as InstallationAuth;
  }
  return appAuth;
}

/**
 * Octokit authenticated as one installation. Cached per installation until its token is about to
 * expire (installation tokens live 1 hour). Concurrent callers share one token request.
 */
export function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const now = Date.now();
  const hit = installationCache.get(installationId);
  if (hit && hit.expiresAt - EXPIRY_SKEW_MS > now) return hit.octokit;

  const entry: CachedInstallation = { expiresAt: Number.POSITIVE_INFINITY, octokit: null! };
  entry.octokit = getAppAuth()({ type: 'installation', installationId }).then(
    ({ token, expiresAt }) => {
      entry.expiresAt = Date.parse(expiresAt);
      return createOctokit({ auth: token });
    },
    (err: unknown) => {
      installationCache.delete(installationId);
      throw err;
    },
  );
  installationCache.set(installationId, entry);
  return entry.octokit;
}

/** Test helper: drop cached clients and credentials. */
export function resetGithubClients(): void {
  appOctokit = undefined;
  appAuth = undefined;
  installationCache.clear();
}

/** Test helper: inject a fake installation-token function. */
export function setInstallationAuthForTesting(fn: InstallationAuth | undefined): void {
  appAuth = fn;
  installationCache.clear();
}
