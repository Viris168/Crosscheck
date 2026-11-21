// Where the tree routes get a full commit graph for on-demand math (GET /tree?visible=, GET /tree/compare).
// Reads the commits-only cache clone (ids, parents, times only; never lazily fetches: `runGit` sets
// GIT_NO_LAZY_FETCH). No repo lock: these are read-only `git log` calls on SHAs the sync already
// fetched, and git writes objects before it moves refs.
// VERIFY: a `git log` concurrent with lane B's `fetch`/`gc --auto` on the same clone is safe without
// `withRepoLock` (the lock lives in lane B and is not exported from '@/server/jobs').
// TODO(T6a/T7): switch to T6a's `loadGraph(<cache>/<id>.graph)` once T7 wires `serializeGraph` into
// the sync; that skips `git log` entirely.
import 'server-only';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CommitGraph } from '@app/git-graph';
import { readCommitGraph } from '@app/git-graph/git';
import { env } from '@/server/env';
import { logger } from '@/server/logger';

/** Same cap as the sync job's read (`TREE_READ_MAX_COMMITS` in lane B). */
export const GRAPH_READ_MAX_COMMITS = 100_000;
/** Graphs kept in memory per process (one 50k-commit graph is a few MB). */
const MEMO_SIZE = 4;

const memo = new Map<string, Promise<CommitGraph | null>>();

/** Cache clone path; mirrors lane B's `cloneDir` (`${REPO_CACHE_DIR}/<githubRepoId>.git`). */
export function cloneDirOf(githubRepoId: number): string {
  if (!Number.isSafeInteger(githubRepoId) || githubRepoId <= 0) throw new Error('invalid repo id');
  return path.resolve(env.REPO_CACHE_DIR, `${githubRepoId}.git`);
}

async function read(githubRepoId: number, heads: readonly string[]): Promise<CommitGraph | null> {
  const gitDir = cloneDirOf(githubRepoId);
  if (!(await stat(gitDir).catch(() => null))) return null;
  const { commits } = await readCommitGraph(gitDir, heads, { maxCommits: GRAPH_READ_MAX_COMMITS });
  return new CommitGraph(commits);
}

/**
 * Commit graph reachable from `heads`, or null when the clone is missing (not synced yet, or this web
 * container has no cache volume). Memoised by repo + head set: a graph for the same heads never changes.
 * A read error is logged (no stderr: it can carry paths) and treated as "no graph".
 */
export function loadCommitGraph(
  repo: { id: string; githubRepoId: number },
  heads: readonly string[],
): Promise<CommitGraph | null> {
  const unique = [...new Set(heads)].sort();
  const key = `${repo.githubRepoId}:${unique.join(',')}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit); // most recently used last
    return hit;
  }
  const p = read(repo.githubRepoId, unique).catch((err: unknown) => {
    memo.delete(key);
    logger.warn(
      { repoId: repo.id, err: err instanceof Error ? err.name : 'unknown' },
      'tree graph read failed',
    );
    return null;
  });
  memo.set(key, p);
  while (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value!);
  return p;
}

/** Test helper. */
export function clearGraphMemo(): void {
  memo.clear();
}
