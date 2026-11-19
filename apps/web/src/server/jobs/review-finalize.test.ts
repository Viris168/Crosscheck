import { ProviderError, type ReviewIssue } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeDeps } from './__fixtures__/deps';
import { createFakeRunner } from './__fixtures__/fake-step';
import { createFakeStore } from './__fixtures__/fake-store';
import { file, patchOf } from './__fixtures__/files';
import { reviewFinalizeHandler } from './review-finalize';

const event = { data: { reviewId: 'rev_1' } };

function run(deps: ReturnType<typeof makeDeps>, runner = createFakeRunner()) {
  return { result: reviewFinalizeHandler({ event, step: runner.step, attempt: 0 }, deps), runner };
}

const issue = (over: Partial<ReviewIssue>): ReviewIssue => ({
  file: 'src/a.ts',
  line: 1,
  severity: 'medium',
  category: 'bug',
  title: 'title',
  explanation: 'explanation',
  ...over,
});

describe('review-finalize', () => {
  it('drops out-of-diff issues, sorts + caps, scores, posts ≥ minSeverity, completes', async () => {
    const db = createFakeStore({
      status: 'running',
      aiRiskScore: 60,
      settings: { minSeverity: 'medium', maxIssuesPerPr: 3 },
      issues: [
        issue({ title: 'low-1', severity: 'low' }),
        issue({ title: 'out-of-diff', line: 999 }),
        issue({ title: 'unknown-file', file: 'nope.ts' }),
        issue({ title: 'crit', severity: 'critical', line: 2 }),
        issue({ title: 'med', severity: 'medium', line: 3 }),
        issue({ title: 'high', severity: 'high', line: 4 }),
      ],
    });
    const deps = makeDeps({ store: db.store, files: [file('src/a.ts', 10)] });
    const { result } = run(deps);
    expect(await result).toEqual({ status: 'completed', issues: 3, posted: 3 });

    // kept in DB: top 3 by severity; out-of-diff + over-cap deleted
    expect(
      db
        .issues()
        .map((i) => i.title)
        .sort(),
    ).toEqual(['crit', 'high', 'med']);
    expect(deps.posts[0]!.issues.map((i) => i.title)).toEqual(['crit', 'med', 'high']);
    expect(deps.posts[0]!.headSha).toBe('abc123');
    expect(deps.posts[0]!.summaryBody).toContain('https://app.test/repos/repo_1/pulls/7');
    // Real @app/scoring: AI 60 × 0.4 = 24 + issues 15 + 8 + 3 = 26 + source without tests 8 → 58
    expect(db.review.risk).toMatchObject({ score: 58, level: 'high' });
    expect(db.review.risk!.factors.map((f) => f.points)).toEqual([24, 26, 8]);
    expect(db.review).toMatchObject({ status: 'completed', githubReviewId: 9001 });
    expect(db.postedIds.size).toBe(3);
  });

  it('keeps sub-minSeverity issues in the DB but does not post them', async () => {
    const db = createFakeStore({
      status: 'waiting_action',
      settings: { minSeverity: 'high' },
      issues: [
        issue({ title: 'low', severity: 'low' }),
        issue({ title: 'crit', severity: 'critical' }),
      ],
    });
    const deps = makeDeps({
      store: db.store,
      files: [{ path: 'src/a.ts', status: 'modified', patch: patchOf(3) }],
    });
    await run(deps).result;
    expect(db.issues()).toHaveLength(2);
    expect(deps.posts[0]!.issues.map((i) => i.title)).toEqual(['crit']);
    expect(db.review.status).toBe('completed');
  });

  it('is a no-op for an already completed review', async () => {
    const db = createFakeStore({ status: 'completed' });
    const deps = makeDeps({ store: db.store, files: [] });
    expect(await run(deps).result).toEqual({ status: 'skipped', reason: 'status_completed' });
    expect(deps.posts).toHaveLength(0);
  });

  it('does not post twice if the review id is already saved', async () => {
    const db = createFakeStore({ status: 'running' });
    db.review.githubReviewId = 123;
    const deps = makeDeps({ store: db.store, files: [file('src/a.ts')] });
    expect(await run(deps).result).toMatchObject({ status: 'completed' });
    expect(deps.posts).toHaveLength(0);
  });

  it('github_error on post → retried twice, then failed / github_error', async () => {
    const db = createFakeStore({ status: 'running', issues: [issue({})] });
    let calls = 0;
    const deps = makeDeps({
      store: db.store,
      files: [file('src/a.ts')],
      postReview: async () => {
        calls++;
        throw new ProviderError('github_error', 'GitHub API error (502) on pulls.createReview');
      },
    });
    const { result, runner } = run(deps);
    expect(await result).toEqual({ status: 'failed', errorCode: 'github_error' });
    expect(calls).toBe(3);
    expect(runner.calls.get('post')).toBe(3);
    expect(db.review).toMatchObject({ status: 'failed', errorCode: 'github_error' });
  });

  it('an untyped post error is reported as github_error', async () => {
    const db = createFakeStore({ status: 'running' });
    const deps = makeDeps({
      store: db.store,
      files: [file('src/a.ts')],
      postReview: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(await run(deps).result).toEqual({ status: 'failed', errorCode: 'github_error' });
  });
});
