// Synthetic large repo for the T6b scale checks: 500 branches / 50 000 commits by default, seeded and
// deterministic. Ids, parents, times, refs, PRs and CI only (what a snapshot may hold). Used by the
// scale tests, the measurement run (scale.measure.test.tsx) and apps/web/scripts/seed-scale-tree.ts.
import { buildSnapshot, type CommitInput, type PrRecord } from '@app/git-graph';
import type { CiState, TreeSnapshot } from '@app/shared/client';

export type ScaleRepo = {
  defaultBranch: string;
  commits: CommitInput[];
  branches: { name: string; headSha: string }[];
  prs: PrRecord[];
  /** CI state by head SHA */
  ci: Record<string, CiState>;
  /** PR numbers opened by "me" (the viewer), for the mine filter */
  minePrs: number[];
};

/** mulberry32: small, fast, good enough for fixtures. */
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

export const scaleSha = (i: number) => (i + 1).toString(16).padStart(40, '0');

const AREAS = ['feature', 'fix', 'chore', 'refactor', 'exp', 'release'];

/**
 * `branches` branches (plus main) over about `commits` commits. One in five branches is stacked on
 * another branch; ~15% have a merged PR, ~40% an open one; CI fails on ~1 in 8 open PRs. Commit times
 * span the last `days` days before `now`, so some branches are stale (> 30 days).
 */
export function scaleRepo({
  branches: nBranches = 500,
  commits: nCommits = 50_000,
  days = 200,
  now = Date.parse('2026-11-20T10:00:00Z'),
  seed = 6,
}: {
  branches?: number;
  commits?: number;
  days?: number;
  now?: number;
  seed?: number;
} = {}): ScaleRepo {
  const rand = rng(seed);
  const commits: CommitInput[] = [];
  const time: number[] = [];
  const start = now - days * 86_400_000;
  const add = (parents: string[], t: number) => {
    const sha = scaleSha(commits.length);
    commits.push({ sha, parents, committedAt: new Date(t).toISOString() });
    time.push(t);
    return sha;
  };

  // main: a fifth of the commits, linear, evenly over the whole span.
  const mainLen = Math.max(1, Math.floor(nCommits / 5));
  const main: string[] = [];
  for (let i = 0; i < mainLen; i++)
    main.push(add(main.length ? [main.at(-1)!] : [], start + ((now - start) * i) / mainLen));

  const perBranch = Math.max(1, Math.floor((nCommits - mainLen) / Math.max(1, nBranches)));
  const out: ScaleRepo['branches'] = [];
  const heads: string[] = [];
  const headIdx: number[] = [];
  const indexOf = new Map(main.map((sha, i) => [sha, i]));
  for (let b = 0; b < nBranches; b++) {
    const stacked = b > 10 && rand() < 0.2;
    let forkSha: string;
    let forkT: number;
    if (stacked) {
      const j = Math.floor(rand() * out.length);
      forkSha = heads[j]!;
      forkT = time[headIdx[j]!]!;
    } else {
      // Biased to recent history, like real repos.
      const at = Math.floor(mainLen * (1 - rand() ** 2));
      forkSha = main[Math.min(mainLen - 1, at)]!;
      forkT = time[Math.min(mainLen - 1, at)]!;
    }
    const k = Math.max(1, Math.round(perBranch * (0.25 + rand() * 1.5)));
    let head = forkSha;
    let t = forkT;
    for (let i = 0; i < k && commits.length < nCommits; i++) {
      t = Math.min(now - 60_000, t + rand() * 4 * 3_600_000);
      head = add([head], t);
      indexOf.set(head, commits.length - 1);
    }
    const name = `${AREAS[b % AREAS.length]}/${b.toString().padStart(3, '0')}-${stacked ? 'stacked' : 'work'}`;
    out.push({ name, headSha: head });
    heads.push(head);
    headIdx.push(indexOf.get(head)!);
  }

  const prs: PrRecord[] = [];
  const ci: Record<string, CiState> = {};
  const minePrs: number[] = [];
  out.forEach((b, i) => {
    const r = rand();
    if (r < 0.55) {
      const merged = r < 0.15;
      const number = prs.length + 1;
      prs.push({
        number,
        headRef: b.name,
        baseRef: 'main',
        state: merged ? 'merged' : 'open',
        headSha: b.headSha,
        mergeMethod: merged ? 'merge' : null,
      });
      if (i % 7 === 0) minePrs.push(number);
      ci[b.headSha] = merged ? 'success' : rand() < 0.125 ? 'failure' : 'success';
    }
  });

  return {
    defaultBranch: 'main',
    commits,
    branches: [{ name: 'main', headSha: main.at(-1)! }, ...out],
    prs,
    ci,
    minePrs,
  };
}

/** The snapshot the sync job would store for `repo` (real engine; 30 drawn commits per branch). */
export function scaleSnapshot(repo: ScaleRepo, maxCommitsPerBranch = 30): TreeSnapshot {
  return buildSnapshot({
    defaultBranch: repo.defaultBranch,
    branches: repo.branches,
    graph: repo.commits,
    prs: repo.prs,
    ci: repo.ci,
    maxCommitsPerBranch,
  });
}
