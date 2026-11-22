// Where the tree routes get a full commit graph for on-demand math (GET /tree?visible=, GET /tree/compare):
// the graph file the sync job stored (T6a), else the commits-only cache clone (ids, parents, times only;
// never lazily fetches: `runGit` sets GIT_NO_LAZY_FETCH). No repo lock: the file is replaced atomically, and
// the clone is only read with `git log` on SHAs the sync already fetched (git writes objects before refs).
// VERIFY: a `git log` concurrent with lane B's `fetch` on the same clone is safe without `withRepoLock`
// (gc is off in the clones).
import 'server-only';
import { stat } from 'node:fs/promises';
import { CommitGraph } from '@app/git-graph';
import { readCommitGraph } from '@app/git-graph/git';
import { loadTreeGraph, treeCloneDir } from '@/server/jobs';
import { logger } from '@/server/logger';

/** Same cap as the sync job's read (`TREE_READ_MAX_COMMITS` in lane B). */
export const GRAPH_READ_MAX_COMMITS = 100_000;
/** Graphs kept in memory per process (one 50k-commit graph is a few MB). */
const MEMO_SIZE = 4;

export type Heads = readonly { name: string; headSha: string }[];

const memo = new Map<string, Promise<CommitGraph | null>>();

async function read(githubRepoId: number, heads: Heads): Promise<CommitGraph | null> {
  // Stale (any branch moved, was added or deleted since) or missing → null → read the clone.
  const stored = await loadTreeGraph({ githubRepoId }, heads);
  if (stored) return stored;
  const gitDir = treeCloneDir(githubRepoId);
  if (!(await stat(gitDir).catch(() => null))) return null;
  const shas = [...new Set(heads.map((h) => h.headSha))];
  const { commits } = await readCommitGraph(gitDir, shas, { maxCommits: GRAPH_READ_MAX_COMMITS });
  return new CommitGraph(commits);
}

/**
 * Commit graph reachable from all of `heads` (the repo's live branches), or null when there is neither a
 * stored graph nor a clone (not synced yet, or this web container has no cache volume). Memoised by repo +
 * head set: a graph for the same heads never changes. A read error is logged (no stderr: it can carry
 * paths) and treated as "no graph".
 */
export function loadCommitGraph(
  repo: { id: string; githubRepoId: number },
  heads: Heads,
): Promise<CommitGraph | null> {
  const refs = heads.map((h) => `${h.headSha} ${h.name}`).sort();
  const key = `${repo.githubRepoId}:${refs.join('\n')}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit); // most recently used last
    return hit;
  }
  const p: Promise<CommitGraph | null> = read(repo.githubRepoId, heads).then(
    (graph) => {
      // "Not there yet" is not an answer to remember: the next sync may create the clone for these heads.
      if (!graph && memo.get(key) === p) memo.delete(key);
      return graph;
    },
    (err: unknown) => {
      if (memo.get(key) === p) memo.delete(key);
      logger.warn(
        { repoId: repo.id, err: err instanceof Error ? err.name : 'unknown' },
        'tree graph read failed',
      );
      return null;
    },
  );
  memo.set(key, p);
  while (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value!);
  return p;
}

/** Test helper. */
export function clearGraphMemo(): void {
  memo.clear();
}
