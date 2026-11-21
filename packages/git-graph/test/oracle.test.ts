// Oracle suite: on real git repos, the engine must agree with git itself for every pair of branches.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, CommitGraph, contentMerged, matchPatchIds, pickCompareWith } from '../src';
import { mergeTreeId, patchIds, readCommitGraph, treeId } from '../src/git';
import { allFixtures, gitAtLeast, gitVersion, type BuiltFixture } from '../src/testing';

const supported = gitAtLeast(2, 38); // merge-tree --write-tree
if (!supported) {
  console.warn(
    `[git-graph] Skipping the oracle suite: needs git >= 2.38, found ${gitVersion()?.join('.') ?? 'none'}.`,
  );
}

describe.skipIf(!supported).each(Object.entries(allFixtures))('oracle: %s', (_key, build) => {
  let fx: BuiltFixture;
  let graph: CommitGraph;
  let names: string[];
  const head = (b: string) => fx.repo.head(b);

  beforeAll(async () => {
    fx = build();
    names = fx.repo.branches();
    const { commits, truncated } = await readCommitGraph(
      fx.repo.gitDir,
      names.map((b) => `refs/heads/${b}`),
    );
    expect(truncated).toBe(false);
    graph = new CommitGraph(commits);
  });
  afterAll(() => fx?.repo.remove());

  const pairs = () =>
    names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b] as const));

  it('reads every commit, ids only', async () => {
    expect(graph.size).toBe(Number(fx.repo.run('rev-list', '--count', '--branches')));
    expect(graph.hasMissingParents).toBe(false);
    const { commits } = await readCommitGraph(fx.repo.gitDir, ['refs/heads/main']);
    for (const c of commits)
      expect(Object.keys(c).sort()).toEqual(['committedAt', 'parents', 'sha']);
    const capped = await readCommitGraph(fx.repo.gitDir, ['refs/heads/main'], { maxCommits: 1 });
    expect(capped.commits).toHaveLength(1);
    expect(capped.truncated).toBe(commits.length > 1);
  });

  it('ahead/behind = git rev-list --count', () => {
    for (const [a, b] of pairs()) {
      const want = {
        ahead: Number(fx.repo.run('rev-list', '--count', `${b}..${a}`)),
        behind: Number(fx.repo.run('rev-list', '--count', `${a}..${b}`)),
      };
      expect(graph.aheadBehind(head(a), head(b)), `${a} vs ${b}`).toEqual(want);
      expect(graph.aheadCommits(head(a), head(b)).sort()).toEqual(
        fx.repo.run('rev-list', `${b}..${a}`).split('\n').filter(Boolean).sort(),
      );
    }
  });

  it('merge bases = git merge-base --all, is-ancestor = git merge-base --is-ancestor', () => {
    for (const [a, b] of pairs()) {
      const all = fx.repo.run('merge-base', '--all', a, b).split('\n').filter(Boolean).sort();
      expect(graph.mergeBases(head(a), head(b)).sort(), `${a} ∧ ${b}`).toEqual(all);
      expect(all).toContain(graph.mergeBase(head(a), head(b)));
      const isAnc = fx.repo.gitResult(['merge-base', '--is-ancestor', a, b]).status === 0;
      expect(graph.isAncestor(head(a), head(b)), `${a} ⊑ ${b}`).toBe(isAnc);
    }
  });

  it('matchPatchIds over adapter patch ids = git cherry', async () => {
    for (const [a, b] of pairs()) {
      const lines = matchPatchIds(
        await patchIds(fx.repo.gitDir, [`${b}..${a}`]),
        await patchIds(fx.repo.gitDir, [`${a}..${b}`]),
      );
      const got = Object.fromEntries(lines.map((l) => [l.sha, l.equivalent ? '-' : '+']));
      const want = Object.fromEntries(
        fx.repo
          .run('cherry', b, a)
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(2), l[0]!]),
      );
      expect(got, `cherry ${b} ${a}`).toEqual(want);
    }
  });

  it('contentMerged(merge-tree) = a real merge into T changes nothing', async () => {
    for (const [b, t] of pairs()) {
      const engine = contentMerged(
        await mergeTreeId(fx.repo.gitDir, t, b),
        await treeId(fx.repo.gitDir, t),
      );
      fx.repo.run('checkout', '-q', '--detach', t);
      const merge = fx.repo.gitResult(['merge', '-q', '--no-ff', '--no-commit', b]);
      const unchanged =
        merge.status === 0 && fx.repo.gitResult(['diff', '--cached', '--quiet', t]).status === 0;
      fx.repo.run('reset', '-q', '--hard');
      expect(engine, `${b} into ${t}`).toBe(unchanged);
    }
    fx.repo.checkout('main');
  });

  it('picks the expected compare-with and PR merge state', () => {
    const input = {
      graph,
      defaultBranch: fx.defaultBranch,
      branches: names.map((name) => ({
        name,
        headSha: head(name),
        recordedParents: fx.recordedParents[name],
      })),
      prs: fx.prs,
      overrides: fx.overrides,
    };
    const got = Object.fromEntries(pickCompareWith(input));
    const want = Object.fromEntries(
      Object.entries(fx.expected).map(([k, v]) => [
        k,
        { whyPr: null, ambiguous: null, loop: false, ...v },
      ]),
    );
    expect(got).toEqual(want);

    const snap = buildSnapshot(input);
    for (const b of snap.branches)
      expect(b.merged, b.name).toEqual(fx.expectedMerged[b.name] ?? null);
  });
});

// Make sure the fixtures exercise both outcomes of the content checks, so the oracle is not vacuous.
describe.skipIf(!supported)('oracle coverage', () => {
  it('has "-" cherry lines and content-merged branches without a PR', async () => {
    const fx = allFixtures.squashMerge();
    const rb = allFixtures.rebaseMerge();
    try {
      const sqTree = await mergeTreeId(fx.repo.gitDir, 'main', 'feature/sq-nopr');
      expect(contentMerged(sqTree, await treeId(fx.repo.gitDir, 'main'))).toBe(true);
      const lines = matchPatchIds(
        await patchIds(rb.repo.gitDir, ['main..feature/partial']),
        await patchIds(rb.repo.gitDir, ['feature/partial..main']),
      );
      expect(lines.map((l) => l.equivalent).sort()).toEqual([false, true]);
      const rbTree = await mergeTreeId(rb.repo.gitDir, 'main', 'feature/partial');
      expect(contentMerged(rbTree, await treeId(rb.repo.gitDir, 'main'))).toBe(false);
    } finally {
      fx.repo.remove();
      rb.repo.remove();
    }
  });
});
