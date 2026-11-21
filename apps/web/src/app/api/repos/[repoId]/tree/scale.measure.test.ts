// T6b scale measurements, server side (opt in: TREE_SCALE_MEASURE=1). Not a pass/fail gate: prints
// timings for the 500-branch / 50k-commit generated repo, including one real `git log` on a
// fast-import-built bare repo (the read GET /tree/compare does on the cache clone).
//   TREE_SCALE_MEASURE=1 pnpm --filter @app/web test -- scale.measure
/* eslint-disable no-console -- prints measurements on purpose */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommitGraph } from '@app/git-graph';
import { readCommitGraph } from '@app/git-graph/git';
import { describe, expect, it } from 'vitest';
import { scaleRepo, scaleSnapshot } from '@/components/tree/__fixtures__/scale-repo';
import { LazyGetTreeResponse, LazyTreeSnapshotSchema } from '@/components/tree/scale-contract';
import { buildSnapshot, compare } from './engine-t6a';

const ms = (t: number) => `${(performance.now() - t).toFixed(1)} ms`;
const time = <T>(label: string, fn: () => T, out: string[]): T => {
  const t = performance.now();
  const r = fn();
  out.push(`${label}: ${ms(t)}`);
  return r;
};

describe.runIf(process.env.TREE_SCALE_MEASURE === '1')('tree scale (server)', () => {
  it('measures', async () => {
    const out: string[] = [];
    const repo = time('generate 500 branches / 50k commits', () => scaleRepo(), out);
    out.push(`  commits=${repo.commits.length} branches=${repo.branches.length}`);
    const stored = time('full snapshot (engine, what sync stores)', () => scaleSnapshot(repo), out);
    const json = JSON.stringify(stored);
    out.push(
      `  snapshot JSON ${(json.length / 1e6).toFixed(2)} MB, ${stored.commits.length} commits`,
    );

    // GET /tree hot path without the DB: parse the stored JSON + validate + serialize the response.
    time(
      'GET /tree body: parse + zod (stored) + zod (response) + stringify',
      () => {
        const parsed = LazyTreeSnapshotSchema.parse(JSON.parse(json));
        const body = LazyGetTreeResponse.parse({
          status: 'ready',
          syncedAt: null,
          errorCode: null,
          snapshot: parsed,
          canEdit: false,
        });
        return JSON.stringify(body).length;
      },
      out,
    );

    const graph = time('CommitGraph from 50k commits', () => new CommitGraph(repo.commits), out);
    const visible = stored.branches.slice(200, 215).map((b) => b.name);
    time(
      'buildSnapshot({ visible: 15 rows }) — T6a MOCK (full compute)',
      () =>
        buildSnapshot({
          defaultBranch: repo.defaultBranch,
          branches: repo.branches,
          graph,
          prs: repo.prs,
          maxCommitsPerBranch: 30,
          visible,
        }),
      out,
    );
    const [a, b] = [repo.branches[300]!.headSha, repo.branches[0]!.headSha];
    time('compare() cold (first walk)', () => compare(graph, a, b), out);
    const pairs = Array.from({ length: 100 }, (_, i) => [
      repo.branches[1 + i]!.headSha,
      repo.branches[400 - i]!.headSha,
    ]);
    const t = performance.now();
    for (const [x, y] of pairs) compare(graph, x!, y!);
    out.push(`compare() avg over 100 pairs: ${((performance.now() - t) / 100).toFixed(2)} ms`);

    // Real git: one bare repo with the same commits (empty trees), then the reads the routes do.
    const dir = mkdtempSync(path.join(tmpdir(), 'tree-scale-'));
    try {
      const gitDir = path.join(dir, 'repo.git');
      execFileSync('git', ['init', '--bare', '-q', gitDir]);
      const marks = new Map(repo.commits.map((c, i) => [c.sha, i + 1]));
      const lines: string[] = [];
      repo.commits.forEach((c, i) => {
        const when = Math.floor(Date.parse(c.committedAt) / 1000);
        const msg = 'x';
        lines.push(`commit refs/heads/b${i}`, `mark :${i + 1}`);
        lines.push(`committer t <t@example.invalid> ${when} +0000`, `data ${msg.length}`, msg);
        if (c.parents[0]) lines.push(`from :${marks.get(c.parents[0])}`);
        else lines.push('deleteall');
        lines.push('');
      });
      let t0 = performance.now();
      execFileSync('git', ['--git-dir', gitDir, 'fast-import', '--quiet'], {
        input: `${lines.join('\n')}\n`,
        maxBuffer: 1 << 28,
      });
      out.push(`git fast-import 50k commits: ${ms(t0)}`);
      // Only the branch heads stay as refs.
      const realHead = (i: number) =>
        execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `refs/heads/b${i}`])
          .toString()
          .trim();
      const ha = realHead(marks.get(a)! - 1);
      const hb = realHead(marks.get(b)! - 1);
      t0 = performance.now();
      const two = await readCommitGraph(gitDir, [ha, hb]);
      out.push(
        `git log for 2 heads (GET /tree/compare, cache miss): ${ms(t0)} → ${two.commits.length} commits`,
      );
      t0 = performance.now();
      const g2 = new CommitGraph(two.commits);
      const r = compare(g2, ha, hb);
      out.push(`  + CommitGraph + compare(): ${ms(t0)}`);
      expect(r.ahead + r.behind).toBeGreaterThan(0);
      const allHeads = repo.branches.map((x) => realHead(marks.get(x.headSha)! - 1));
      t0 = performance.now();
      const all = await readCommitGraph(gitDir, allHeads);
      out.push(
        `git log for all 501 heads (GET /tree?visible= first fill): ${ms(t0)} → ${all.commits.length}`,
      );
      // git merges synthetic commits that are byte-identical (same parent, time and message).
      expect(all.commits.length).toBeGreaterThan(repo.commits.length * 0.98);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const mem = process.memoryUsage();
    out.push(
      `rss ${(mem.rss / 1e6).toFixed(0)} MB, heapUsed ${(mem.heapUsed / 1e6).toFixed(0)} MB`,
    );
    console.log(`\n${out.join('\n')}\n`);
  }, 300_000);
});
