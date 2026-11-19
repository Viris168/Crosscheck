import 'server-only';
import { getAppOctokit } from '@app/github';
import { logger } from '@/server/logger';

let cached: Promise<string | null> | undefined;

/**
 * GitHub's "Install" page for our App (`https://github.com/apps/<slug>/installations/new`), where a
 * user picks the account and repos. The slug comes from GET /app, once per process. `null` when the
 * App isn't configured or GitHub can't be reached (the next call tries again).
 */
export function getInstallUrl(): Promise<string | null> {
  cached ??= getAppOctokit()
    .rest.apps.getAuthenticated()
    .then(({ data }) => {
      if (!data?.slug) throw new Error('GitHub returned no app slug');
      return `https://github.com/apps/${encodeURIComponent(data.slug)}/installations/new`;
    })
    .catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'could not resolve the GitHub App install URL');
      cached = undefined;
      return null;
    });
  return cached;
}

/** Test helper. */
export function resetInstallUrlCache(): void {
  cached = undefined;
}
