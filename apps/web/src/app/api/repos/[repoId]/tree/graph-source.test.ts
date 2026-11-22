// The graph the tree routes compute on: the sync's stored graph for exactly these heads, else the clone.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommitGraph } from '@app/git-graph';
import * as gitGraph from '@app/git-graph/git';
import { FixtureRepo } from '@app/git-graph/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({ loadTreeGraph: vi.fn(), treeCloneDir: vi.fn() }));
vi.mock('@/server/jobs', () => jobs);
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@app/git-graph/git', async (orig) => {
  const real = await orig<typeof gitGraph>();
  return { ...real, readCommitGraph: vi.fn(real.readCommitGraph) };
});

const { clearGraphMemo, loadCommitGraph } = await import('./graph-source');

const REPO = { id: 'r1', githubRepoId: 4242 };
let repo: FixtureRepo;
let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  clearGraphMemo();
  repo = FixtureRepo.create('t7-graph-source');
  repo.commit('one');
  repo.branch('feat');
  repo.commit('two');
  dir = mkdtempSync(path.join(tmpdir(), 't7-graph-source-'));
  jobs.treeCloneDir.mockReturnValue(path.join(repo.dir, '.git'));
  // The real cache: files in `dir`, as lane B writes them.
  jobs.loadTreeGraph.mockImplementation((r: typeof REPO, heads: ReturnType<typeof headsOf>) =>
    gitGraph.loadGraph(
      dir,
      String(r.githubRepoId),
      heads.map((h) => [`refs/heads/${h.name}`, h.headSha] as const),
    ),
  );
});
afterEach(() => {
  repo.remove();
  rmSync(dir, { recursive: true, force: true });
});

const headsOf = () => repo.branches().map((name) => ({ name, headSha: repo.head(name) }));
async function store() {
  const heads = headsOf();
  const { commits } = await gitGraph.readCommitGraph(
    path.join(repo.dir, '.git'),
    heads.map((h) => h.headSha),
  );
  await gitGraph.saveGraph(
    dir,
    '4242',
    new CommitGraph(commits),
    heads.map((h) => [`refs/heads/${h.name}`, h.headSha] as const),
  );
  vi.mocked(gitGraph.readCommitGraph).mockClear();
}

describe('loadCommitGraph', () => {
  it('uses the stored graph without running git, and remembers it', async () => {
    await store();
    const graph = await loadCommitGraph(REPO, headsOf());
    expect(graph?.has(repo.head('feat'))).toBe(true);
    expect(await loadCommitGraph(REPO, headsOf())).toBe(graph);
    expect(jobs.loadTreeGraph).toHaveBeenCalledTimes(1);
    expect(gitGraph.readCommitGraph).not.toHaveBeenCalled();
  });

  it('a stored graph for other heads is ignored: the clone answers', async () => {
    await store();
    repo.commit('three');
    const graph = await loadCommitGraph(REPO, headsOf());
    expect(graph?.has(repo.head('feat'))).toBe(true);
    expect(gitGraph.readCommitGraph).toHaveBeenCalledTimes(1);
  });

  it('neither → null, and the next call looks again', async () => {
    const clone = jobs.treeCloneDir();
    jobs.treeCloneDir.mockReturnValue(path.join(dir, 'missing.git'));
    expect(await loadCommitGraph(REPO, headsOf())).toBeNull();
    jobs.treeCloneDir.mockReturnValue(clone);
    expect(await loadCommitGraph(REPO, headsOf())).not.toBeNull();
  });
});
