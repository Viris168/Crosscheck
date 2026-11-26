// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { RepoList, sortRepos } from './repo-list';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reposResponse(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );
}

const INSTALL = 'https://github.com/apps/x/installations/new';

describe('RepoList empty state', () => {
  it('owner/admin: offers to install the GitHub App', async () => {
    reposResponse([]);
    renderWithQuery(<RepoList installUrl={INSTALL} canManage />);
    expect(await screen.findByText(/No repositories yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Install GitHub App/ })).toBeTruthy();
  });

  it('member: explains access comes from GitHub, with no install button', async () => {
    reposResponse([]);
    renderWithQuery(<RepoList installUrl={INSTALL} canManage={false} />);
    expect(
      await screen.findByText("You don't have access to any repositories here yet."),
    ).toBeTruthy();
    expect(screen.queryByText(/No repositories yet/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Install GitHub App/ })).toBeNull();
  });
});

describe('sortRepos', () => {
  it('puts Claude/Codex Action repos first and keeps name order within each group', () => {
    const repos = [
      { fullName: 'a/alpha', provider: 'platform' },
      { fullName: 'a/beta', provider: 'claude_action' },
      { fullName: 'a/gamma', provider: 'codex_chatgpt' },
      { fullName: 'a/delta', provider: 'codex_action' },
      { fullName: 'a/omega', provider: 'claude_action' },
    ] as const;
    expect(sortRepos([...repos]).map((r) => r.fullName)).toEqual([
      'a/beta',
      'a/delta',
      'a/omega',
      'a/alpha',
      'a/gamma',
    ]);
  });
});
