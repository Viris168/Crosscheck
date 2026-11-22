// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { RepoList } from './repo-list';

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

const REPO = {
  id: 'r1',
  orgId: 'org1',
  fullName: 'acme/web',
  provider: 'platform',
  active: true,
  hasIngestToken: false,
  lastReview: null,
};

describe('RepoList rows', () => {
  it('links each repo to its branch tree', async () => {
    reposResponse([REPO]);
    renderWithQuery(<RepoList />);
    const link = await screen.findByRole('link', { name: 'Branches of acme/web' });
    expect(link.getAttribute('href')).toBe('/repos/r1/tree');
  });
});

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
