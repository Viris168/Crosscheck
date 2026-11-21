// T6a scale benchmark: 500 branches / 50 000 commits (budget in ../README.md).
// Run: pnpm --filter @app/git-graph bench   (CI runs it non-blocking and only logs the table)
// Everything is synthetic (bench/generate.ts) except one real-git run for readCommitGraph, whose repo
// is written with `git fast-import` into a temp dir (empty trees, so it takes a second or two).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { buildSnapshot, CommitGraph, parseGraph, pickCompareWith, serializeGraph } from '../src';
import { loadGraph, readCommitGraph, refSetHash, saveGraph } from '../src/git';
import { generateRepo, toFastImport } from './generate';

const BRANCHES = 500;
const COMMITS = 50_000;
const VISIBLE = 40; // rows a virtualized list shows at once

const repo = generateRepo({ branches: BRANCHES, commits: COMMITS });
const base = { defaultBranch: repo.defaultBranch, branches: repo.branches, prs: repo.prs };
const refs = Object.fromEntries(repo.branches.map((b) => [`refs/heads/${b.name}`, b.headSha]));
const bytes = serializeGraph(new CommitGraph(repo.commits), refSetHash(refs));
const fresh = () => parseGraph(bytes).graph;

// Rows a user scrolled to: a window in the middle of the tree order.
const order = buildSnapshot({ ...base, graph: fresh() }).branches.map((b) => b.name);
const visible = order.slice(200, 200 + VISIBLE);
const timeBySha = new Map(repo.commits.map((c) => [c.sha, c.committedAt]));
// The pair with the longest walk: the oldest feature head vs main (behind by most of the history).
const oldest = repo.branches
  .filter((b) => b.name !== 'main')
  .reduce((a, b) =>
    Date.parse(commitTime(a.headSha)) < Date.parse(commitTime(b.headSha)) ? a : b,
  );
const mainHead = repo.branches.find((b) => b.name === 'main')!.headSha;
const near = repo.branches.find((b) => b.name === visible[0])!.headSha;
function commitTime(sha: string) {
  return timeBySha.get(sha)!;
}

// Real git repo for readCommitGraph.
const dir = mkdtempSync(join(tmpdir(), 'git-graph-bench-'));
const gitDir = join(dir, 'repo.git');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['init', '-q', '--bare', gitDir], { env });
const marksFile = join(dir, 'marks');
execFileSync(
  'git',
  ['--git-dir', gitDir, 'fast-import', '--quiet', `--export-marks=${marksFile}`],
  {
    env,
    input: toFastImport(repo),
    maxBuffer: 1 << 30,
  },
);
execFileSync('git', ['--git-dir', gitDir, 'update-ref', '-d', 'refs/gen/tmp'], { env });
const refNames = repo.branches.map((b) => `refs/heads/${b.name}`);
// mark n = repo.commits[n - 1]; the real SHAs differ from the generator's fake ones
const realSha = new Map<string, string>();
for (const line of readFileSync(marksFile, 'utf8').split('\n')) {
  const [mark, sha] = line.split(' ');
  if (mark && sha) realSha.set(repo.commits[Number(mark.slice(1)) - 1]!.sha, sha);
}
const real = (sha: string) => realSha.get(sha)!;
const realBase = {
  defaultBranch: repo.defaultBranch,
  branches: repo.branches.map((b) => ({ ...b, headSha: real(b.headSha) })),
  prs: repo.prs.map((p) => ({
    ...p,
    headSha: p.headSha && real(p.headSha),
    mergeCommitSha: p.mergeCommitSha && real(p.mergeCommitSha),
  })),
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Memory: what one sync/API call keeps alive (commits read from real git, the graph, a full snapshot),
// measured after a GC (`--expose-gc` is set for bench workers in vitest.config.ts).
const gc = (globalThis as { gc?: () => void }).gc;
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
gc?.();
const before = used();
const rssBefore = process.memoryUsage().rss;
const kept = await (async () => {
  const { commits } = await readCommitGraph(gitDir, refNames);
  const graph = new CommitGraph(commits);
  return { commits, graph, snapshot: buildSnapshot({ ...realBase, graph }) };
})();
const peakDuring = process.resourceUsage().maxRSS * 1024; // ru_maxrss is KB on Linux
gc?.();
const retained = used() - before;

const once = { iterations: 5, time: 0, warmupIterations: 1 };
const often = { iterations: 30, time: 0, warmupIterations: 3 };
// "Cold" = a graph just loaded from the cache file, with no reach sets or walks cached.
// VERIFY: vitest 3.2 bench does not pass tinybench's per-iteration `beforeEach` (observed: the hook never
// ran), so each run takes the next graph from a pool filled in `setup` instead.
let pool: CommitGraph[] = [];
const COLD_RUNS = 10;
const coldGraph = {
  iterations: COLD_RUNS,
  time: 0,
  warmupIterations: 1,
  setup() {
    pool = Array.from({ length: COLD_RUNS + 2 }, fresh);
  },
  teardown() {
    pool = [];
  },
};
const take = () => pool.pop() ?? fresh();

describe(`read (${COMMITS} commits, ${BRANCHES} refs)`, () => {
  bench(
    'readCommitGraph (real git log)',
    async () => {
      const { commits } = await readCommitGraph(gitDir, refNames);
      if (commits.length !== COMMITS) throw new Error(`read ${commits.length} commits`);
    },
    once,
  );
  bench(
    'new CommitGraph(commits)',
    () => {
      new CommitGraph(repo.commits);
    },
    often,
  );
  bench(
    'graph cache: loadGraph (file → graph)',
    async () => {
      if (!(await loadGraph(dir, 'bench', refs))) throw new Error('cache miss');
    },
    {
      ...often,
      async setup() {
        await saveGraph(dir, 'bench', fresh(), refs);
      },
    },
  );
  bench(
    'graph cache: serializeGraph',
    () => {
      serializeGraph(take(), refSetHash(refs));
    },
    coldGraph,
  );
});

describe('snapshot (cold graph: no cached walks)', () => {
  bench(
    `buildSnapshot({ visible: ${VISIBLE} rows })`,
    () => {
      buildSnapshot({ ...base, graph: take(), visible });
    },
    coldGraph,
  );
  bench(
    'buildSnapshot (every row)',
    () => {
      buildSnapshot({ ...base, graph: take() });
    },
    coldGraph,
  );
  bench(
    'pickCompareWith (every branch; part of both above)',
    () => {
      pickCompareWith({ ...base, graph: take() });
    },
    coldGraph,
  );
  bench(
    `pickCompareWith({ only: ${VISIBLE} visible }) (chains only)`,
    () => {
      pickCompareWith({ ...base, graph: take(), only: visible });
    },
    coldGraph,
  );
});

describe('one pair (cold graph)', () => {
  bench(
    'aheadBehind: visible branch vs main',
    () => {
      take().aheadBehind(near, mainHead);
    },
    coldGraph,
  );
  bench(
    'aheadBehind: oldest branch vs main (worst case)',
    () => {
      take().aheadBehind(oldest.headSha, mainHead);
    },
    coldGraph,
  );
  bench(
    'compare: oldest branch vs main (worst case)',
    () => {
      take().compare(oldest.headSha, mainHead);
    },
    coldGraph,
  );
});

afterAll(() => {
  const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} MB`;
  // ru_maxrss is in KB on Linux. Includes the vitest worker itself.
  // eslint-disable-next-line no-console -- the bench's job is to log these numbers
  console.log(
    `[git-graph bench] read + graph + full snapshot: retained ${mb(retained)}${gc ? '' : ' (no --expose-gc: rough)'}, ` +
      `process peak RSS ${mb(peakDuring)} (worker was at ${mb(rssBefore)} before; includes the generator and vitest); ` +
      `graph file ${mb(bytes.byteLength)}; full snapshot draws ${kept.snapshot.commits.length} commits`,
  );
});
