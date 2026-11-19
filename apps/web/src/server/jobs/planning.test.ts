import { LIMITS } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { file, hugePr, pr136 } from './__fixtures__/files';
import {
  estimateTokens,
  globToRegExp,
  isRiskyPath,
  planChunks,
  prepareFile,
  reviewableFiles,
  truncatePatch,
} from './planning';

describe('reviewableFiles', () => {
  it('drops removed, binary, secret-like, lockfiles and ignorePaths', () => {
    const files = [
      file('src/ok.ts'),
      file('src/gone.ts', 3, 'removed'),
      { path: 'img/logo.png', status: 'added' as const, patch: '' },
      file('.env'),
      file('config/.env.production'),
      file('certs/server.pem'),
      file('keys/id.key'),
      file('pnpm-lock.yaml'),
      file('web/package-lock.json'),
      file('Cargo.lock'),
      file('dist/bundle.js'),
      file('docs/readme.md'),
    ];
    const kept = reviewableFiles(files, ['dist/**', 'docs/*.md']).map((f) => f.path);
    expect(kept).toEqual(['src/ok.ts']);
  });

  it('globs: ** spans directories, * stays in a segment', () => {
    expect(globToRegExp('**/*.lock').test('a/b/c.lock')).toBe(true);
    expect(globToRegExp('**/*.lock').test('c.lock')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('planChunks', () => {
  it('small PR → one chunk', () => {
    const plan = planChunks([file('a.ts'), file('b.ts')]);
    expect(plan.chunks).toEqual([['a.ts', 'b.ts']]);
    expect(plan).toMatchObject({ filesTotal: 2, tooLarge: false, skippedFiles: 0 });
  });

  it('136-file PR → several chunks, each within the token limit, every file exactly once', () => {
    const files = pr136();
    const plan = planChunks(files);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.flat().sort()).toEqual(files.map((f) => f.path).sort());
    const tokens = new Map(files.map((f) => [f.path, estimateTokens(f.patch)]));
    for (const chunk of plan.chunks) {
      expect(chunk.reduce((n, p) => n + tokens.get(p)!, 0)).toBeLessThanOrEqual(LIMITS.chunkTokens);
    }
    expect(plan.tooLarge).toBe(false);
  });

  it('huge PR → too_large, riskiest files kept first, total within budget', () => {
    const files = hugePr();
    const plan = planChunks(files);
    expect(plan.tooLarge).toBe(true);
    expect(plan.skippedFiles).toBeGreaterThan(0);
    const kept = plan.chunks.flat();
    expect(kept.length).toBe(plan.filesTotal);
    // all 20 risky files survive and come first
    expect(kept.slice(0, 20).every(isRiskyPath)).toBe(true);
    const total = files
      .filter((f) => kept.includes(f.path))
      .reduce((n, f) => n + estimateTokens(f.patch), 0);
    expect(total).toBeLessThanOrEqual(LIMITS.totalTokens);
  });

  it('a single file larger than a chunk is truncated to its first hunks with a note', () => {
    const big = file('src/big.ts', 6000); // ~75k tokens
    const plan = planChunks([big]);
    expect(plan.truncatedFiles).toBe(1);
    const prepared = prepareFile(big);
    expect(estimateTokens(prepared.patch)).toBeLessThanOrEqual(LIMITS.chunkTokens);
    expect(prepared.patch).toMatch(/\n\\ Truncated by the reviewer/);
  });

  it('truncatePatch keeps whole hunks when they fit', () => {
    const patch = ['@@ -1,1 +1,1 @@', '+a', '@@ -10,1 +10,1 @@', '+' + 'x'.repeat(400)].join('\n');
    const out = truncatePatch(patch, 40);
    expect(out.truncated).toBe(true);
    expect(out.patch.startsWith('@@ -1,1 +1,1 @@\n+a\n\\ Truncated')).toBe(true);
    expect(truncatePatch('@@ -1 +1 @@\n+a', 100)).toEqual({
      patch: '@@ -1 +1 @@\n+a',
      truncated: false,
    });
  });
});
