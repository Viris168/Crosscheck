// @vitest-environment jsdom
import { ErrorCode, ReviewDetailSchema, type ReviewDetail } from '@app/shared/client';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { failureMessage } from './failure-message';
import { ReviewPanel, ReviewState } from './review-panel';
import type { ReviewActions } from './review-states';

afterEach(cleanup);

const ctx = { repoId: 'r1', repoFullName: 'acme/web', prNumber: 42, prPath: '/repos/r1/pulls/42' };

function review(over: Partial<ReviewDetail> = {}): ReviewDetail {
  return ReviewDetailSchema.parse({
    id: 'rev_1',
    status: 'completed',
    provider: 'platform',
    headSha: 'abcdef1234567',
    stale: false,
    errorCode: null,
    errorMessage: null,
    filesTotal: 12,
    filesDone: 5,
    risk: null,
    summary: null,
    issues: [],
    createdAt: new Date(Date.now() - 65_000).toISOString(),
    finishedAt: null,
    ...over,
  });
}

const actions = (): ReviewActions => ({ onRetry: vi.fn(), onRerun: vi.fn(), pending: false });

describe('review states', () => {
  it('queued: waiting to start, provider, cancel (disabled until the contract lands)', () => {
    render(<ReviewState review={review({ status: 'queued' })} ctx={ctx} actions={actions()} />);
    expect(screen.getByText('Waiting to start')).toBeTruthy();
    expect(screen.getByText('Platform')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
  });

  it('running: progress X of Y and elapsed time', () => {
    render(
      <ReviewState
        review={review({ status: 'running', provider: 'codex_chatgpt' })}
        ctx={ctx}
        actions={actions()}
      />,
    );
    expect(screen.getByText('Reviewed 5 of 12 files')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
    expect(bar.getAttribute('aria-valuemax')).toBe('12');
    expect(screen.getByText(/^1m \d+s$/)).toBeTruthy();
  });

  it.each([
    ['claude_action', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['codex_action', 'OPENAI_API_KEY'],
  ] as const)('waiting_action (%s): checklist, Actions link, setup link', (provider, secret) => {
    render(
      <ReviewState
        review={review({ status: 'waiting_action', provider })}
        ctx={ctx}
        actions={actions()}
      />,
    );
    expect(screen.getByText('Waiting for your GitHub Action')).toBeTruthy();
    const checklist = screen.getByRole('list', { name: 'Setup checklist' });
    expect(checklist.textContent).toContain(secret);
    expect(checklist.textContent).toContain('PLATFORM_INGEST_TOKEN');
    expect(screen.getByRole('link', { name: /Open Actions tab/ }).getAttribute('href')).toBe(
      'https://github.com/acme/web/actions',
    );
    expect(screen.getByRole('link', { name: 'Open setup' }).getAttribute('href')).toBe(
      '/repos/r1/setup',
    );
  });

  it('completed: risk, factors, summary, issues by file with jump links, re-run actions', async () => {
    const a = actions();
    render(
      <ReviewState
        review={review({
          status: 'completed',
          stale: true,
          risk: {
            score: 64,
            level: 'high',
            factors: [{ key: 'ai', label: 'AI estimate', points: 24 }],
          },
          summary: 'Looks risky.',
          issues: [
            {
              id: 'i1',
              posted: true,
              file: 'src/a.ts',
              line: 31,
              severity: 'high',
              category: 'security',
              title: 'SQL injection',
              explanation: 'Raw query.',
            },
          ],
        })}
        ctx={ctx}
        actions={a}
      />,
    );
    expect(screen.getByLabelText('Risk score').textContent).toBe('64');
    expect(screen.getByText('High risk')).toBeTruthy();
    expect(screen.getByText('AI estimate')).toBeTruthy();
    expect(screen.getByText('Looks risky.')).toBeTruthy();
    expect(screen.getByText('Stale review.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'src/a.ts' })).toBeTruthy();
    const href = screen.getByRole('link', { name: /SQL injection/ }).getAttribute('href')!;
    expect(href).toBe(
      '/repos/r1/pulls/42?tab=files&file=src%2Fa.ts&line=31&review=rev_1#diff-src_a_ts-R31',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(a.onRerun).toHaveBeenCalledWith();
    await userEvent.selectOptions(screen.getByLabelText('Other provider'), 'codex_action');
    await userEvent.click(screen.getByRole('button', { name: 'Re-run with' }));
    expect(a.onRerun).toHaveBeenCalledWith('codex_action');
  });

  it('completed with too_large shows the partial-review notice', () => {
    render(
      <ReviewState
        review={review({ status: 'completed', errorCode: 'too_large', filesTotal: 300 })}
        ctx={ctx}
        actions={actions()}
      />,
    );
    expect(screen.getByText(/This PR is very large \(300 files\)/)).toBeTruthy();
  });

  it('failed: message, retry, change provider', async () => {
    const a = actions();
    render(
      <ReviewState
        review={review({ status: 'failed', errorCode: 'timeout' })}
        ctx={ctx}
        actions={a}
      />,
    );
    expect(screen.getByTestId('failure-message').textContent).toBe('The review took too long.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(a.onRetry).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Change provider' }).getAttribute('href')).toBe(
      '/repos/r1/settings',
    );
  });
});

describe('failure messages', () => {
  const text = (over: Partial<ReviewDetail>) => {
    const { container } = render(<>{failureMessage(review({ status: 'failed', ...over }), ctx)}</>);
    const t = container.textContent;
    cleanup();
    return t;
  };

  it('covers every ErrorCode', () => {
    for (const code of ErrorCode) expect(text({ errorCode: code })).toBeTruthy();
  });

  it.each([
    [
      { errorCode: 'too_large', filesTotal: 250 },
      'This PR is very large (250 files). We reviewed the riskiest files first.',
    ],
    [
      { errorCode: 'provider_auth', provider: 'claude_action' },
      'Your Claude token expired — run claude setup-token and update the CLAUDE_CODE_OAUTH_TOKEN secret.',
    ],
    [{ errorCode: 'provider_auth', provider: 'codex_chatgpt' }, 'Reconnect ChatGPT.'],
    [
      { errorCode: 'rate_limited' },
      "Your plan's usage limit was reached. Retry later or switch provider.",
    ],
    [{ errorCode: 'timeout' }, 'The review took too long.'],
    [
      { errorCode: 'action_missing' },
      "Your GitHub Action didn't send a result. View workflow runs",
    ],
    [{ errorCode: 'invalid_output' }, 'The AI returned an invalid result.'],
    [{ errorCode: 'github_error' }, 'Something went wrong on our side. Review id: rev_1'],
    [{ errorCode: 'internal' }, 'Something went wrong on our side. Review id: rev_1'],
  ] as [Partial<ReviewDetail>, string][])('%o', (over, expected) => {
    expect(text(over)).toBe(expected);
  });

  it('action_missing links to the workflow runs', () => {
    render(<>{failureMessage(review({ errorCode: 'action_missing' }), ctx)}</>);
    expect(screen.getByRole('link', { name: 'View workflow runs' }).getAttribute('href')).toBe(
      'https://github.com/acme/web/actions',
    );
  });
});

describe('ReviewPanel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries through the API and reports the new review id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ reviewId: 'rev_1', status: 'queued' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const onStarted = vi.fn();
    renderWithQuery(
      <ReviewPanel
        review={review({ status: 'failed', errorCode: 'internal' })}
        ctx={ctx}
        onStarted={onStarted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('rev_1'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/reviews/rev_1/retry');
  });

  it('shows the API error message when a re-run conflicts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'conflict', message: 'This review is already in progress' } },
            { status: 409 },
          ),
        ),
    );
    renderWithQuery(<ReviewPanel review={review({ status: 'completed' })} ctx={ctx} />);
    await userEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(await screen.findByText('This review is already in progress')).toBeTruthy();
  });
});
