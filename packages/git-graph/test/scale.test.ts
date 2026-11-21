// T6a: the fast paths (two-colour walk, bitset fallback, cached sets) must give exactly what a naive
// set-based oracle gives; the lazy table and the graph cache must not change any computed value.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  CommitGraph,
  compare,
  GraphFormatError,
  NOT_COMPUTED,
  parseGraph,
  pickCompareWith,
  serializeGraph,
  type CommitInput,
} from '../src';
import { loadGraph, refSetHash, saveGraph } from '../src/git';
import { fakeSha, generateRepo } from '../bench/generate';

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

/**
 * Random DAG: several long lines of work (so walks can exceed the budget), merges between lines,
 * octopus merges, extra roots, criss-crosses, and optionally parents that are missing from the input.
 */
function randomDag(n: number, seed: number, missing = false): CommitInput[] {
  const rand = rng(seed);
  const lines: number[] = [];
  const out: CommitInput[] = [];
  for (let i = 0; i < n; i++) {
    const parents: string[] = [];
    const r = rand();
    if (i === 0 || r < 0.01) {
      lines.push(i); // new root
    } else {
      const li = Math.floor(rand() * lines.length);
      parents.push(fakeSha(lines[li]!));
      if (r < 0.08 && lines.length > 1) parents.push(fakeSha(lines[(li + 1) % lines.length]!));
      if (r < 0.01 && lines.length > 2) parents.push(fakeSha(lines[(li + 2) % lines.length]!));
      if (r > 0.97)
        lines.push(i); // fork a new line here
      else lines[li] = i;
    }
    if (missing && rand() < 0.002) parents.push('f'.repeat(40));
    out.push({
      sha: fakeSha(i),
      parents,
      committedAt: new Date(1e12 + ((i * 7919) % 500_000)).toISOString(),
    });
  }
  return out;
}

/** Naive oracle: explicit ancestor sets. */
function oracle(commits: CommitInput[]) {
  const known = new Set(commits.map((c) => c.sha));
  const parents = new Map(commits.map((c) => [c.sha, c.parents.filter((p) => known.has(p))]));
  const memo = new Map<string, Set<string>>();
  const reach = (s: string): Set<string> => {
    const hit = memo.get(s);
    if (hit) return hit;
    const seen = new Set<string>();
    const stack = [s];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...parents.get(x)!);
    }
    memo.set(s, seen);
    return seen;
  };
  return {
    reach,
    bases(a: string, b: string): string[] {
      const A = reach(a);
      const B = reach(b);
      const common = [...A].filter((x) => B.has(x));
      const commonSet = new Set(common);
      const notBest = new Set(common.flatMap((x) => parents.get(x)!));
      return common.filter((x) => commonSet.has(x) && !notBest.has(x)).sort();
    },
  };
}

describe('CommitGraph fast paths = naive oracle', () => {
  for (const [label, n, seed, missing] of [
    ['small', 300, 1, false],
    ['walks over budget', 4000, 2, false],
    ['missing parents', 3000, 3, true],
  ] as const) {
    it(label, () => {
      const commits = randomDag(n, seed, missing);
      const o = oracle(commits);
      const rand = rng(seed + 100);
      const pick = () => commits[Math.floor(rand() * commits.length)]!.sha;
      const pairs = Array.from({ length: 150 }, () => [pick(), pick()] as const);
      pairs.push(
        [commits[0]!.sha, commits[n - 1]!.sha],
        [commits[n - 1]!.sha, commits[n - 1]!.sha],
      );
      // fresh graph (walks), then the same graph once every set is cached (bitsets)
      const g = new CommitGraph(commits);
      const cached = new CommitGraph(commits);
      for (const [a, b] of pairs) {
        cached.reachable(a);
        cached.reachable(b);
      }
      for (const graph of [g, cached, new CommitGraph(commits)]) {
        for (const [a, b] of pairs) {
          const A = o.reach(a);
          const B = o.reach(b);
          const ahead = [...A].filter((x) => !B.has(x));
          const behind = [...B].filter((x) => !A.has(x)).length;
          const bases = o.bases(a, b);
          expect(graph.aheadBehind(a, b), `${a} vs ${b}`).toEqual({ ahead: ahead.length, behind });
          expect(graph.isAncestor(a, b)).toBe(B.has(a));
          expect([...graph.mergeBases(a, b)].sort()).toEqual(bases);
          expect(graph.aheadCommits(a, b)).toEqual(graph.sortTopological(ahead));
          const c = compare(graph, a, b);
          expect(c).toEqual({ ahead: ahead.length, behind, mergeBase: graph.mergeBase(a, b) });
          if (bases.length) expect(bases).toContain(c.mergeBase);
          else expect(c.mergeBase).toBeNull();
        }
      }
      for (const sha of [commits[n - 1]!.sha, pick()])
        for (const k of [1, 7, 50, n + 5])
          expect(g.reachableTail(sha, k)).toEqual(g.reachable(sha).slice(-k));
    });
  }
});

describe('lazy table', () => {
  const repo = generateRepo({ branches: 120, commits: 6000, seed: 7 });
  const names = repo.branches.map((b) => b.name);
  // Hand-set overrides that form loops, so chains and loop breaking are exercised.
  const overrides: Record<string, string> = {};
  const rand = rng(9);
  for (let i = 0; i < 40; i++) {
    const a = names[1 + Math.floor(rand() * (names.length - 1))]!;
    overrides[a] = names[1 + Math.floor(rand() * (names.length - 1))]!;
  }
  // explicit two- and three-way loops, and branches pointing into them
  const [p, q, x, y, z, into1, into2] = names.slice(60, 67) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  Object.assign(overrides, { [p]: q, [q]: p, [x]: y, [y]: z, [z]: x, [into1]: q, [into2]: z });
  const input = { defaultBranch: 'main', branches: repo.branches, prs: repo.prs, overrides };
  const graph = new CommitGraph(repo.commits);
  const full = pickCompareWith({ ...input, graph });
  const chain = (b: string) => {
    const out = new Set<string>(['main']);
    for (let x: string | null = b; x && !out.has(x); x = full.get(x)!.compareWith) out.add(x);
    return out;
  };

  it('has loops to break', () => {
    expect([...full.values()].filter((c) => c.loop).length).toBeGreaterThan(0);
  });

  it('pickCompareWith({ only }) = the full picks for those branches and their chains', () => {
    for (let i = 0; i < 60; i++) {
      const only = names.filter(() => rand() < 0.05);
      // a fresh graph each time, so nothing cached from the full run helps
      const got = pickCompareWith({ ...input, graph: new CommitGraph(repo.commits), only });
      const want = new Set(['main', ...only.flatMap((b) => [...chain(b)])]);
      expect(new Set(got.keys())).toEqual(want);
      for (const [b, c] of got) expect(c, b).toEqual(full.get(b));
    }
    expect([...pickCompareWith({ ...input, graph, only: ['nope'] }).keys()]).toEqual(['main']);
  });

  it('buildSnapshot({ visible }) computes visible rows + chains, the same as the full snapshot', () => {
    const all = buildSnapshot({ ...input, graph: new CommitGraph(repo.commits) });
    expect(
      buildSnapshot({ ...input, graph: new CommitGraph(repo.commits), visible: names }),
    ).toEqual(all);
    const visible = names.slice(30, 50);
    const lazy = buildSnapshot({ ...input, graph: new CommitGraph(repo.commits), visible });
    const computed = new Set(visible.flatMap((b) => [...chain(b)]));
    expect(lazy.branches.map((b) => b.name)).toEqual(all.branches.map((b) => b.name));
    const allBy = new Map(all.branches.map((b) => [b.name, b]));
    for (const row of lazy.branches) {
      const want = allBy.get(row.name)!;
      if (computed.has(row.name)) expect(row).toEqual(want);
      else
        expect(row).toEqual({
          ...want,
          ahead: NOT_COMPUTED,
          behind: NOT_COMPUTED,
          mergeBase: null,
        });
    }
    const allShas = new Set(all.commits.map((c) => c.sha));
    expect(lazy.commits.length).toBeLessThan(all.commits.length);
    for (const c of lazy.commits) expect(allShas.has(c.sha)).toBe(true);
    // still parents before children
    const pos = new Map(lazy.commits.map((c, i) => [c.sha, i]));
    for (const c of lazy.commits)
      for (const p of c.parents) if (pos.has(p)) expect(pos.get(p)!).toBeLessThan(pos.get(c.sha)!);
  });
});

describe('graph cache', () => {
  const repo = generateRepo({ branches: 40, commits: 2000, seed: 3 });
  const refs = Object.fromEntries(repo.branches.map((b) => [`refs/heads/${b.name}`, b.headSha]));
  const dir = mkdtempSync(join(tmpdir(), 'git-graph-cache-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips every answer and commit (times to the second)', () => {
    const g = new CommitGraph(repo.commits);
    const bytes = serializeGraph(g, refSetHash(refs));
    // 20-byte SHAs + int32 parents + uint32 times + 56-byte header
    const edges = repo.commits.reduce((n, c) => n + c.parents.length, 0);
    expect(bytes.byteLength).toBe(56 + 2000 * 20 + 4 * 2001 + 4 * edges + 4 * 2000);
    const { graph: h, refsHash } = parseGraph(bytes);
    expect(refsHash).toBe(refSetHash(refs));
    expect(h.size).toBe(g.size);
    expect(h.hasMissingParents).toBe(false);
    for (const c of repo.commits) expect(h.commit(c.sha)).toEqual(g.commit(c.sha));
    const heads = repo.branches.map((b) => b.headSha);
    for (const a of heads.slice(0, 10))
      for (const b of heads) expect(h.compare(a, b)).toEqual(g.compare(a, b));
    expect(
      buildSnapshot({ defaultBranch: 'main', branches: repo.branches, prs: repo.prs, graph: h }),
    ).toEqual(
      buildSnapshot({ defaultBranch: 'main', branches: repo.branches, prs: repo.prs, graph: g }),
    );
  });

  it('keeps missing-parent flags and SHA-256 ids; refuses non-hex SHAs', () => {
    const cut = new CommitGraph([
      { sha: 'a'.repeat(64), parents: ['b'.repeat(64)], committedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const back = parseGraph(serializeGraph(cut, '0'.repeat(64))).graph;
    expect(back.hasMissingParents).toBe(true);
    expect(back.commit('a'.repeat(64)).committedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(() =>
      serializeGraph(new CommitGraph([{ sha: 'x', parents: [], committedAt: '' }]), '0'.repeat(64)),
    ).toThrow();
    expect(() => serializeGraph(cut, 'nothex')).toThrow();
  });

  it('rejects malformed bytes', () => {
    const bytes = serializeGraph(new CommitGraph(repo.commits.slice(0, 50)), '0'.repeat(64));
    expect(() => parseGraph(bytes.slice(0, 40))).toThrow(GraphFormatError);
    expect(() => parseGraph(bytes.slice(0, bytes.length - 4))).toThrow(GraphFormatError);
    const bad = bytes.slice();
    bad[0] = 0;
    expect(() => parseGraph(bad)).toThrow(GraphFormatError);
    const badParent = bytes.slice();
    const view = new DataView(badParent.buffer);
    const parentListAt = 56 + 50 * 20 + 4 * 51;
    view.setInt32(parentListAt, 9999, true);
    expect(() => parseGraph(badParent)).toThrow(GraphFormatError);
    const dup = bytes.slice();
    dup.copyWithin(56 + 20, 56, 56 + 20); // commit 1 gets commit 0's SHA
    expect(() => parseGraph(dup)).toThrow(GraphFormatError);
  });

  it('saveGraph / loadGraph: stale on any ref change, null when missing or corrupt', async () => {
    const g = new CommitGraph(repo.commits);
    expect(await loadGraph(dir, 'r1', refs)).toBeNull();
    await saveGraph(dir, 'r1', g, refs);
    const back = await loadGraph(dir, 'r1', new Map(Object.entries(refs).reverse()));
    expect(back?.size).toBe(g.size);
    expect(
      await loadGraph(dir, 'r1', { ...refs, 'refs/heads/new': repo.branches[0]!.headSha }),
    ).toBeNull();
    expect(
      await loadGraph(dir, 'r1', { ...refs, 'refs/heads/main': repo.branches[1]!.headSha }),
    ).toBeNull();
    writeFileSync(join(dir, 'r2.graph'), 'garbage');
    expect(await loadGraph(dir, 'r2', refs)).toBeNull();
    await expect(saveGraph(dir, '../escape', g, refs)).rejects.toThrow('Invalid graph cache id');
  });
});
