import 'server-only';
import type { Installation, PullRequest, Repo } from '@app/db';
import { fetchPullRequestFiles, getInstallationOctokit, splitFullName } from '@app/github';
import type { ChangedFileSchema } from '@app/shared';
import type { z } from 'zod';

type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** Counts `+` / `-` lines of a unified diff (hunk headers excluded). */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * Changed files of a PR, fetched live from GitHub with the repo's installation token.
 * Patches are never stored; this is called on every PR page load.
 */
export async function fetchPullFiles(
  repo: Pick<Repo, 'fullName'>,
  installation: Pick<Installation, 'githubInstallationId'>,
  pull: Pick<PullRequest, 'number'>,
): Promise<ChangedFile[]> {
  const { owner, repo: name } = splitFullName(repo.fullName);
  const octokit = await getInstallationOctokit(installation.githubInstallationId);
  const files = await fetchPullRequestFiles(octokit, owner, name, pull.number);
  return files.map((f) => ({
    path: f.path,
    status: f.status,
    ...countPatchLines(f.patch),
    patch: f.patch || null,
  }));
}
