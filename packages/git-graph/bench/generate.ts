// Synthetic repo generator for the scale benchmark (T6a). Deterministic (seeded), no git needed.
// Shape: a long `main` with merge commits from feature branches, a few long-lived branches, stacked
// feature branches, stale branches cut long ago, and merged branches whose refs were never deleted.
// `toFastImport` turns the same history into a `git fast-import` stream for the one real-git run.
import type { CommitInput, PrRecord, SnapshotBranchInput } from '../src';

export interface GenerateOptions {
  branches?: number;
  commits?: number;
  seed?: number;
}

export interface GeneratedRepo {
  defaultBranch: string;
  /** creation order (parents before children) */
  commits: CommitInput[];
  branches: SnapshotBranchInput[];
  prs: PrRecord[];
}

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fake but well-formed 40-hex SHA, unique per index. */
export const fakeSha = (i: number) =>
  ((i * 2654435761) >>> 0).toString(16).padStart(8, '0') + i.toString(16).padStart(32, '0');

export function generateRepo(opts: GenerateOptions = {}): GeneratedRepo {
  const nBranches = opts.branches ?? 500;
  const nCommits = opts.commits ?? 50_000;
  const rand = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

  const commits: CommitInput[] = [];
  let clock = 1_600_000_000;
  const commit = (parents: string[]): string => {
    const sha = fakeSha(commits.length);
    clock += 60 + Math.floor(rand() * 600);
    commits.push({ sha, parents, committedAt: new Date(clock * 1000).toISOString() });
    return sha;
  };

  const heads = new Map<string, string>();
  const mainHistory: string[] = [];
  const open: string[] = []; // feature branches still receiving commits
  const prs: PrRecord[] = [];
  let prNumber = 0;

  heads.set('main', commit([]));
  mainHistory.push(heads.get('main')!);
  const longLived = ['develop', 'staging', 'release/1.0', 'release/2.0'];
  const featureCount = nBranches - 1 - longLived.length;
  // Branch creations spread evenly across the history; long-lived ones early.
  const createAt = new Map<number, string[]>();
  const at = (i: number, name: string) => createAt.set(i, [...(createAt.get(i) ?? []), name]);
  longLived.forEach((name, i) => at(Math.floor(((i + 1) * nCommits) / 20), name));
  for (let i = 0; i < featureCount; i++)
    at(
      Math.floor(((i + 0.5) * (nCommits - 50)) / featureCount),
      `feature/f${String(i).padStart(3, '0')}`,
    );

  while (commits.length < nCommits) {
    for (const name of createAt.get(commits.length) ?? []) {
      const r = rand();
      let base: string;
      if (longLived.includes(name) || r < 0.7) base = heads.get('main')!;
      else if (r < 0.85 && open.length)
        base = heads.get(pick(open))!; // stacked
      else base = pick(mainHistory.slice(0, Math.max(1, mainHistory.length - 200))); // stale-ish
      heads.set(name, base);
      if (!longLived.includes(name)) open.push(name);
    }
    const r = rand();
    if (r < 0.45 || !open.length) {
      const sha = commit([heads.get('main')!]);
      heads.set('main', sha);
      mainHistory.push(sha);
    } else if (r < 0.93) {
      const b = pick(open);
      heads.set(b, commit([heads.get(b)!]));
    } else if (r < 0.98) {
      // merge a feature into main and stop working on it (the ref stays)
      const i = Math.floor(rand() * open.length);
      const b = open[i]!;
      open.splice(i, 1);
      const head = heads.get(b)!;
      if (head === heads.get('main')) continue;
      const sha = commit([heads.get('main')!, head]);
      heads.set('main', sha);
      mainHistory.push(sha);
      if (rand() < 0.6)
        prs.push({
          number: ++prNumber,
          headRef: b,
          baseRef: 'main',
          state: 'merged',
          headSha: head,
          mergeMethod: 'merge',
          mergeCommitSha: sha,
        });
    } else {
      // long-lived branches follow main now and then
      const ll = pick(longLived);
      if (heads.has(ll) && heads.get(ll) !== heads.get('main')) {
        const sha = commit([heads.get(ll)!, heads.get('main')!]);
        heads.set(ll, sha);
      }
    }
  }
  // Some open branches have an open PR.
  for (const b of open)
    if (rand() < 0.3)
      prs.push({
        number: ++prNumber,
        headRef: b,
        baseRef: 'main',
        state: 'open',
        headSha: heads.get(b)!,
      });

  return {
    defaultBranch: 'main',
    commits,
    branches: [...heads].map(([name, headSha]) => ({ name, headSha })),
    prs,
  };
}

/** A `git fast-import` stream for the repo: empty trees, one ref per branch. Returns stream + sha→mark. */
export function toFastImport(repo: GeneratedRepo): string {
  const mark = new Map<string, number>();
  const out: string[] = [];
  for (const c of repo.commits) {
    const m = mark.size + 1;
    mark.set(c.sha, m);
    const t = Math.floor(Date.parse(c.committedAt) / 1000);
    out.push(
      `commit refs/gen/tmp\nmark :${m}\ncommitter Bench <bench@example.invalid> ${t} +0000\ndata 1\nc\n`,
    );
    if (c.parents.length) {
      out.push(`from :${mark.get(c.parents[0]!)}\n`);
      for (const p of c.parents.slice(1)) out.push(`merge :${mark.get(p)}\n`);
    }
    out.push('\n');
  }
  for (const b of repo.branches)
    out.push(`reset refs/heads/${b.name}\nfrom :${mark.get(b.headSha)}\n\n`);
  return out.join('');
}
