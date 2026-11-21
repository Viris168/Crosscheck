// Read ids out of a git dir. Only SHAs, parent SHAs and commit times are ever parsed: never subjects,
// bodies or author emails. patchIds / mergeTreeId / treeId need trees and blobs, so on the cache clone
// they fail by design (lazy fetch is off); T3a calls them in a throwaway workspace.
import type { CommitInput } from '../core/graph';
import { runGit, type RunGitOptions } from './run-git';

type Opts = Pick<RunGitOptions, 'env' | 'timeoutMs'>;

const git = (
  gitDir: string,
  args: string[],
  opts: Opts & Pick<RunGitOptions, 'input' | 'okExitCodes'> = {},
) => runGit(['--git-dir', gitDir, ...args], opts);

function assertRev(rev: string) {
  if (!rev || rev.startsWith('-') || /[\s\0]/.test(rev))
    throw new Error('Invalid revision argument');
}

export interface ReadCommitGraphOptions extends Opts {
  /** stop after this many commits (newest first) and report `truncated` */
  maxCommits?: number;
}

/** Commits reachable from `refs` (full ref names or SHAs). */
export async function readCommitGraph(
  gitDir: string,
  refs: readonly string[],
  opts: ReadCommitGraphOptions = {},
): Promise<{ commits: CommitInput[]; truncated: boolean }> {
  if (!refs.length) return { commits: [], truncated: false };
  refs.forEach(assertRev);
  const max = opts.maxCommits;
  const { stdout } = await git(
    gitDir,
    [
      '-c',
      'log.showSignature=false',
      'log',
      '--no-color',
      '--format=%H %P%x09%ct',
      ...(max !== undefined ? [`--max-count=${max + 1}`] : []),
      '--end-of-options',
      ...refs,
    ],
    opts,
  );
  const commits: CommitInput[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ids = '', ct = '0'] = line.split('\t');
    const [sha, ...parents] = ids.trim().split(' ').filter(Boolean);
    if (!sha) continue;
    commits.push({ sha, parents, committedAt: new Date(Number(ct) * 1000).toISOString() });
  }
  const truncated = max !== undefined && commits.length > max;
  return { commits: truncated ? commits.slice(0, max) : commits, truncated };
}

/**
 * `git patch-id --stable` for every non-merge commit in `revs` (e.g. ['T..B']). Returns sha → patch id.
 * The diff text stays in memory between the two git processes and is never returned or logged.
 */
export async function patchIds(
  gitDir: string,
  revs: readonly string[],
  opts: Opts = {},
): Promise<Map<string, string>> {
  revs.forEach(assertRev);
  // VERIFY: git cherry's internal patch ids vs `git patch-id --stable` agree on renames/binary files
  // (the oracle covers text edits only).
  const log = await git(
    gitDir,
    [
      'log',
      '--no-merges',
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--format=commit %H',
      '--end-of-options',
      ...revs,
    ],
    opts,
  );
  const out = new Map<string, string>();
  if (!log.stdout.trim()) return out;
  const { stdout } = await git(gitDir, ['patch-id', '--stable'], { ...opts, input: log.stdout });
  for (const line of stdout.split('\n')) {
    const [patchId, sha] = line.trim().split(' ');
    if (patchId && sha) out.set(sha, patchId);
  }
  return out;
}

/** Tree of `git merge-tree --write-tree a b`, or null when the merge conflicts. */
export async function mergeTreeId(
  gitDir: string,
  a: string,
  b: string,
  opts: Opts = {},
): Promise<string | null> {
  assertRev(a);
  assertRev(b);
  // --no-messages keeps file names out of stdout; exit 1 = conflicts.
  const res = await git(gitDir, ['merge-tree', '--write-tree', '--no-messages', a, b], {
    ...opts,
    okExitCodes: [0, 1],
  });
  if (res.exitCode !== 0) return null;
  return res.stdout.split('\n')[0]!.trim() || null;
}

/** `rev^{tree}`. */
export async function treeId(gitDir: string, rev: string, opts: Opts = {}): Promise<string> {
  assertRev(rev);
  const { stdout } = await git(
    gitDir,
    ['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`],
    opts,
  );
  return stdout.trim();
}
