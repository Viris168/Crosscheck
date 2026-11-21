import { runGit } from './run-git';

/**
 * Throws if the git dir holds any tree or blob (i.e. file contents or names). For the commits-only
 * cache clone (which has no alternates). Note `--batch-all-objects` also counts alternates.
 */
export async function assertNoContents(gitDir: string): Promise<void> {
  const counts = await objectCounts(gitDir);
  const trees = counts.tree ?? 0;
  const blobs = counts.blob ?? 0;
  if (trees || blobs) {
    throw new Error(`[internal] cache clone holds contents (${trees} trees, ${blobs} blobs)`);
  }
}

/** Object counts by type in this git dir. */
export async function objectCounts(gitDir: string): Promise<Record<string, number>> {
  const { stdout } = await runGit([
    '--git-dir',
    gitDir,
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objecttype)',
  ]);
  const counts: Record<string, number> = {};
  for (const type of stdout.split('\n')) if (type) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}
