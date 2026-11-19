import { ProviderError, type ReviewFile, type ReviewIssue } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import { OUTDATED_PREFIX, SUMMARY_MARKER } from './format';
import { postReview, selectInlineIssues, type ReviewOctokit } from './post';

const file = (
  path: string,
  lines: number,
  status: ReviewFile['status'] = 'modified',
): ReviewFile => ({
  path,
  status,
  patch:
    `@@ -0,0 +1,${lines} @@\n` +
    Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join('\n'),
});

const issue = (fileName: string, line: number, title = 't'): ReviewIssue => ({
  file: fileName,
  line,
  severity: 'medium',
  category: 'bug',
  title,
  explanation: 'e',
});

function httpError(status: number, message = 'Unprocessable Entity', errors?: unknown[]) {
  return Object.assign(new Error(message), { status, response: { data: { message, errors } } });
}

type CreateParams = Parameters<ReviewOctokit['rest']['pulls']['createReview']>[0];

function mockOctokit(
  opts: {
    create?: (p: CreateParams) => Promise<{ data: { id: number } }>;
    reviews?: Awaited<ReturnType<ReviewOctokit['rest']['pulls']['listReviews']>>['data'];
  } = {},
) {
  const createReview = vi.fn(opts.create ?? (async () => ({ data: { id: 999 } })));
  const listReviews = vi.fn(async () => ({ data: opts.reviews ?? [] }));
  const updateReview = vi.fn(async () => ({}));
  const octokit: ReviewOctokit = { rest: { pulls: { createReview, listReviews, updateReview } } };
  return { octokit, createReview, listReviews, updateReview };
}

const base = {
  fullName: 'acme/app',
  prNumber: 7,
  headSha: 'head2',
  summaryBody: `${SUMMARY_MARKER}\n## summary`,
};

describe('selectInlineIssues', () => {
  it('splits inline / overflow / out-of-diff and skips removed files', () => {
    const files = [file('a.ts', 5), file('gone.ts', 5, 'removed')];
    const sel = selectInlineIssues(
      files,
      [issue('a.ts', 1), issue('a.ts', 9), issue('gone.ts', 1), issue('b.ts', 1), issue('a.ts', 2)],
      1,
    );
    expect(sel).toEqual({ inline: [0], overflow: [4], outOfDiff: [1, 2, 3] });
  });
});

describe('postReview', () => {
  it('posts one COMMENT review on the head commit with RIGHT-side comments, skipping out-of-diff issues', async () => {
    const m = mockOctokit();
    const issues = [
      issue('a.ts', 2, 'one'),
      issue('a.ts', 50),
      issue('other.ts', 1),
      issue('a.ts', 3, 'three'),
    ];
    const res = await postReview(m.octokit, { ...base, files: [file('a.ts', 3)], issues });

    expect(res).toEqual({ githubReviewId: 999, postedIssueIndexes: [0, 3] });
    expect(m.createReview).toHaveBeenCalledTimes(1);
    const p = m.createReview.mock.calls[0]![0];
    expect(p).toMatchObject({
      owner: 'acme',
      repo: 'app',
      pull_number: 7,
      commit_id: 'head2',
      event: 'COMMENT',
    });
    expect(p.comments.map((c) => [c.path, c.line, c.side])).toEqual([
      ['a.ts', 2, 'RIGHT'],
      ['a.ts', 3, 'RIGHT'],
    ]);
    expect(p.comments[0]!.body).toContain('— one');
    expect(p.body).toBe(base.summaryBody); // nothing overflowed; out-of-diff issues are dropped
  });

  it('caps inline comments at 50 and lists the rest in the summary', async () => {
    const m = mockOctokit();
    const issues = Array.from({ length: 55 }, (_, i) => issue('a.ts', i + 1, `n${i}`));
    const res = await postReview(m.octokit, { ...base, files: [file('a.ts', 60)], issues });

    expect(res.postedIssueIndexes).toHaveLength(50);
    const p = m.createReview.mock.calls[0]![0];
    expect(p.comments).toHaveLength(50);
    expect(p.body).toContain('### Not posted inline (5)');
    expect(p.body).toContain('a\\.ts\\:51 — n50');
    expect(p.body).toContain('a\\.ts\\:55 — n54');
  });

  it('adds the summary marker when the body lacks it', async () => {
    const m = mockOctokit();
    await postReview(m.octokit, { ...base, summaryBody: 'plain', files: [], issues: [] });
    expect(m.createReview.mock.calls[0]![0].body).toBe(`${SUMMARY_MARKER}\nplain`);
  });

  it('on 422 naming a file, retries once without those comments', async () => {
    const m = mockOctokit({
      create: vi
        .fn<(p: CreateParams) => Promise<{ data: { id: number } }>>()
        .mockRejectedValueOnce(
          httpError(422, 'Unprocessable Entity', ['Path could not be resolved: b.ts']),
        )
        .mockResolvedValueOnce({ data: { id: 5 } }),
    });
    const issues = [issue('a.ts', 1), issue('b.ts', 1), issue('a.ts', 2)];
    const res = await postReview(m.octokit, {
      ...base,
      files: [file('a.ts', 2), file('b.ts', 2)],
      issues,
    });

    expect(m.createReview).toHaveBeenCalledTimes(2);
    expect(m.createReview.mock.calls[1]![0].comments.map((c) => c.path)).toEqual(['a.ts', 'a.ts']);
    expect(m.createReview.mock.calls[1]![0].body).toContain('### Not posted inline (1)');
    expect(res).toEqual({ githubReviewId: 5, postedIssueIndexes: [0, 2] });
  });

  it('on an unspecific 422, retries once with no inline comments', async () => {
    const m = mockOctokit({
      create: vi
        .fn<(p: CreateParams) => Promise<{ data: { id: number } }>>()
        .mockRejectedValueOnce(httpError(422, 'Line could not be resolved'))
        .mockResolvedValueOnce({ data: { id: 6 } }),
    });
    const res = await postReview(m.octokit, {
      ...base,
      files: [file('a.ts', 2)],
      issues: [issue('a.ts', 1)],
    });
    expect(m.createReview.mock.calls[1]![0].comments).toEqual([]);
    expect(m.createReview.mock.calls[1]![0].body).toContain('### Not posted inline (1)');
    expect(res).toEqual({ githubReviewId: 6, postedIssueIndexes: [] });
  });

  it('retries only once, then throws github_error', async () => {
    const m = mockOctokit({ create: async () => Promise.reject(httpError(422)) });
    const err = await postReview(m.octokit, {
      ...base,
      files: [file('a.ts', 2)],
      issues: [issue('a.ts', 1)],
    }).catch((e: unknown) => e);
    expect(m.createReview).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('github_error');
  });

  it('does not retry other errors', async () => {
    const m = mockOctokit({ create: async () => Promise.reject(httpError(500, 'boom')) });
    await expect(
      postReview(m.octokit, { ...base, files: [file('a.ts', 2)], issues: [issue('a.ts', 1)] }),
    ).rejects.toMatchObject({ code: 'github_error' });
    expect(m.createReview).toHaveBeenCalledTimes(1);
    expect(m.listReviews).not.toHaveBeenCalled();
  });

  it('marks earlier bot summaries on older commits as outdated, and nothing else', async () => {
    const m = mockOctokit({
      reviews: [
        { id: 1, commit_id: 'head1', body: `${SUMMARY_MARKER}\nold`, user: { type: 'Bot' } }, // → outdated
        {
          id: 2,
          commit_id: 'head1',
          body: `${OUTDATED_PREFIX}\n\n${SUMMARY_MARKER}`,
          user: { type: 'Bot' },
        },
        { id: 3, commit_id: 'head1', body: 'human review', user: { type: 'User' } },
        { id: 4, commit_id: 'head1', body: SUMMARY_MARKER, user: { type: 'User' } }, // copied marker
        { id: 5, commit_id: 'head2', body: SUMMARY_MARKER, user: { type: 'Bot' } }, // same commit
        { id: 999, commit_id: 'head1', body: SUMMARY_MARKER, user: { type: 'Bot' } }, // the new one
      ],
    });
    await postReview(m.octokit, { ...base, files: [], issues: [] });
    expect(m.updateReview).toHaveBeenCalledTimes(1);
    expect(m.updateReview).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      pull_number: 7,
      review_id: 1,
      body: `${OUTDATED_PREFIX} ([newer review](https://github.com/acme/app/pull/7#pullrequestreview-999))\n\n${SUMMARY_MARKER}\nold`,
    });
  });

  it('a failure while marking outdated does not fail the post', async () => {
    const m = mockOctokit();
    m.listReviews.mockRejectedValueOnce(httpError(500));
    await expect(postReview(m.octokit, { ...base, files: [], issues: [] })).resolves.toEqual({
      githubReviewId: 999,
      postedIssueIndexes: [],
    });
  });

  it('rejects a malformed full name', async () => {
    const m = mockOctokit();
    await expect(
      postReview(m.octokit, { ...base, fullName: 'nope', files: [], issues: [] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
