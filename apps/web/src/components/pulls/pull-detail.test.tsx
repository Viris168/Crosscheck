// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseView } from '@/components/tree/view';
import { renderWithQuery } from '../../../test/render';
import { PullDetail } from './pull-detail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/repos/r1/pulls/7',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('"Show in branch tree" opens the tree searched for the head branch', async () => {
  const headRef = 'feat/a&b #1';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        pull: {
          id: 'p1',
          repoId: 'r1',
          repoFullName: 'acme/web',
          number: 7,
          title: 'Add login',
          body: null,
          author: 'octo',
          state: 'closed',
          headSha: 'a'.repeat(40),
          baseRef: 'main',
          headRef,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          updatedAt: '2026-11-20T10:00:00.000Z',
          htmlUrl: 'https://github.com/acme/web/pull/7',
        },
        files: [],
        review: null,
        reviews: [],
      }),
    ),
  );
  renderWithQuery(<PullDetail repoId="r1" number={7} />);
  const link = await screen.findByRole('link', { name: 'Show in branch tree' });
  const url = new URL(link.getAttribute('href')!, 'http://localhost');
  expect(url.pathname).toBe('/repos/r1/tree');
  expect(parseView(url.search).q).toBe(headRef);
});
