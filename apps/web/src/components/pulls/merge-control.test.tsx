// @vitest-environment jsdom
import { ReviewDetailSchema, type ReviewDetail } from '@app/shared/client';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { MergeControl, mergeBlocker } from './merge-control';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function review(over: Partial<ReviewDetail> = {}): ReviewDetail {
  return ReviewDetailSchema.parse({
    id: 'rev_1',
    status: 'completed',
    provider: 'platform',
    headSha: 'abcdef1234567',
    stale: false,
    errorCode: null,
    errorMessage: null,
    filesTotal: 2,
    filesDone: 2,
    risk: { score: 20, level: 'low', factors: [] },
    summary: null,
    issues: [],
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  });
}

describe('mergeBlocker', () => {
  it('allows only a completed review of the latest commit', () => {
    expect(mergeBlocker(review())).toBeNull();
    expect(mergeBlocker(null)).toMatch(/needs a review/);
    expect(mergeBlocker(review({ stale: true }))).toMatch(/latest commit/);
    expect(mergeBlocker(review({ status: 'running' }))).toMatch(/once the review completes/);
    expect(mergeBlocker(review({ status: 'failed' }))).toMatch(/once the review completes/);
  });
});

describe('MergeControl', () => {
  it('is disabled with the reason until the review completes', () => {
    renderWithQuery(<MergeControl repoId="r1" number={42} review={review({ status: 'queued' })} />);
    expect(screen.getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/once the review completes/)).toBeTruthy();
  });

  it('asks for confirmation, then merges with the chosen method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ merged: true, sha: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    renderWithQuery(<MergeControl repoId="r1" number={42} review={review()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('Merge method'), 'squash');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/repos/r1/pulls/42/merge');
    expect(JSON.parse(init.body)).toEqual({ method: 'squash' });
  });

  it('warns about high risk before merging', async () => {
    renderWithQuery(
      <MergeControl
        repoId="r1"
        number={42}
        review={review({ risk: { score: 80, level: 'critical', factors: [] } })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByText(/critical risk/)).toBeTruthy();
  });

  it("shows GitHub's refusal", async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'conflict', message: "GitHub can't merge this pull request: nope" } },
            { status: 409 },
          ),
        ),
    );
    renderWithQuery(<MergeControl repoId="r1" number={42} review={review()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(await screen.findByText(/can't merge this pull request: nope/)).toBeTruthy();
  });
});
