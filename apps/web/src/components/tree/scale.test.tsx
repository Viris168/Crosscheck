// @vitest-environment jsdom
// T6b: the Branches tab at scale — virtualized rows, URL filters, collapse, on-demand compare.
import { GetTreeResponse, type TreeSnapshot } from '@app/shared/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { scaleRepo, scaleSnapshot } from './__fixtures__/scale-repo';
import { seedSnapshot } from './__fixtures__/seed-snapshot';
import { BranchTree } from './branch-tree';
import { NOT_COMPUTED } from './scale-contract';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

let big: TreeSnapshot;
let minePrs: number[];
beforeAll(() => {
  const repo = scaleRepo();
  big = scaleSnapshot(repo);
  minePrs = repo.minePrs;
});

const body = (snapshot: TreeSnapshot) =>
  GetTreeResponse.parse({
    status: 'ready',
    syncedAt: '2026-11-20T10:00:00.000Z',
    errorCode: null,
    snapshot,
    canEdit: false,
    viewerLogin: 'octo',
  });

let fetchMock: ReturnType<typeof vi.fn>;
function serve(
  snapshot: TreeSnapshot,
  opts: { compare?: () => Response; tree?: (url: string) => TreeSnapshot } = {},
) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/tree/compare'))
      return opts.compare?.() ?? Response.json({ ahead: 4, behind: 2, mergeBase: null });
    const snap = opts.tree?.(url) ?? snapshot;
    return Response.json(body(snap));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const render = () => renderWithQuery(<BranchTree repoId="r1" repoFullName="acme/big" />);
const branchRows = () => document.querySelectorAll('[data-branch]');

beforeEach(() => window.history.replaceState(null, '', '/repos/r1/tree'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('virtualized list', () => {
  it('renders fewer than 60 rows for 500 branches', async () => {
    serve(big);
    render();
    await screen.findByRole('button', { name: /^Repository big, 501 branches/ });
    const n = branchRows().length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(60);
    // Commits are drawn only for those rows.
    expect(document.querySelectorAll('[data-shape]').length).toBeLessThan(60 * 8);
  });

  it('scrolling draws the rows in the new window', async () => {
    serve(big);
    render();
    await screen.findByRole('button', { name: /^Repository big/ });
    const first = branchRows()[0]!.getAttribute('data-branch');
    const scroller = screen.getByTestId('tree-scroller');
    // jsdom has no layout: fake the scroll position, then fire the event the virtualizer listens to.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 78 * 200 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(branchRows()[0]!.getAttribute('data-branch')).not.toBe(first));
    expect(branchRows().length).toBeLessThan(60);
  });
});

describe('search and filters in the URL', () => {
  it('reads ?q=&f= on load and writes changes back', async () => {
    window.history.replaceState(null, '', '/repos/r1/tree?q=stacked&f=open-pr&tab=keep');
    serve(big);
    render();
    const search = (await screen.findByRole('searchbox', {
      name: 'Search branches',
    })) as HTMLInputElement;
    expect(search.value).toBe('stacked');
    expect(screen.getByRole('button', { name: 'With open PR' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const matches = [...branchRows()].filter((r) => !r.hasAttribute('data-context'));
    expect(matches.length).toBeGreaterThan(0);
    for (const r of matches) expect(r.getAttribute('data-branch')).toContain('stacked');

    await userEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(window.location.search).toBe('?tab=keep&q=stacked&f=mine%2Copen-pr');
    await userEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(window.location.search).toBe('?tab=keep');
    expect(search.value).toBe('');
  });

  it('says when nothing matches', async () => {
    window.history.replaceState(null, '', '/repos/r1/tree?q=no-such-branch');
    serve(big);
    render();
    expect(await screen.findByText(/No branches match/)).toBeTruthy();
    expect(screen.getByText('0 of 501 branches')).toBeTruthy();
  });
});

describe('collapse', () => {
  it('folds a subtree and a long run of commits, and expands them on click', async () => {
    serve(seedSnapshot());
    render();
    const toggle = await screen.findByRole('button', {
      name: 'Collapse the 2 branches compared with dev',
    });
    await userEvent.click(toggle);
    expect(document.querySelector('[data-branch="feature/login"]')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Expand the 2 branches compared with dev' }),
    );
    expect(document.querySelector('[data-branch="feature/login"]')).toBeTruthy();
  });

  it('a long run shows "… N commits" and expands to every drawn commit', async () => {
    const snap: TreeSnapshot = { ...big, branches: big.branches.slice(0, 1) }; // main only: 30 drawn
    serve(snap);
    render();
    const chip = await screen.findByRole('button', { name: /^Show \d+ older commits on main$/ });
    expect(within(chip).getByText(/^… \d+ commits$/)).toBeTruthy();
    const before = document.querySelectorAll('[data-shape]').length;
    await userEvent.click(chip);
    const after = document.querySelectorAll('[data-shape]').length;
    expect(after).toBeGreaterThan(before);
    // Still oldest → newest, head on the right.
    const shas = [...document.querySelectorAll('[data-branch="main"] [data-shape]')];
    expect(shas.at(-1)!.hasAttribute('data-head')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /^Hide older commits on main/ }));
    expect(document.querySelectorAll('[data-shape]').length).toBe(before);
  });
});

describe('any two branches', () => {
  it('shift-click a second row → GET /tree/compare → ahead/behind/merge-base panel', async () => {
    serve(seedSnapshot());
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Branch dev,/ }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: /^Branch hotfix\/header,/ }));
    await user.keyboard('{/Shift}');
    const aside = screen.getByRole('complementary');
    expect(within(aside).getByText(/Compare/)).toBeTruthy();
    await within(aside).findByTestId('compare-result');
    expect(within(aside).getByText(/↑4 commits on dev not on hotfix\/header/)).toBeTruthy();
    expect(within(aside).getByText(/↓2 commits on hotfix\/header not on dev/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repos/r1/tree/compare?a=dev&b=hotfix%2Fheader',
      expect.anything(),
    );
  });

  it('the details select picks the second branch; a 409 is explained', async () => {
    serve(seedSnapshot(), {
      compare: () =>
        Response.json(
          { error: { code: 'conflict', message: 'Refresh it first.' } },
          { status: 409 },
        ),
    });
    render();
    await userEvent.click(await screen.findByRole('button', { name: /^Branch dev,/ }));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Compare dev with any branch' }),
      'main',
    );
    expect(await screen.findByText('Refresh it first.')).toBeTruthy();
  });
});

describe('lazy counts (T6a NOT_COMPUTED)', () => {
  it('shows "…" for rows without counts and asks GET /tree for the visible ones', async () => {
    const lazy: TreeSnapshot = {
      ...big,
      branches: big.branches.map((b) =>
        b.isDefault ? b : { ...b, ahead: NOT_COMPUTED, behind: NOT_COMPUTED, mergeBase: null },
      ),
    };
    serve(lazy, {
      tree: (url) => {
        const want = new URL(url, 'http://x').searchParams.getAll('visible');
        return want.length
          ? {
              ...lazy,
              branches: lazy.branches.map((b, i) => (want.includes(b.name) ? big.branches[i]! : b)),
            }
          : lazy;
      },
    });
    render();
    await screen.findByRole('button', { name: /^Repository big/ });
    const uncounted = () =>
      [...document.querySelectorAll('[data-branch] > .bt-node')].filter((e) =>
        e.getAttribute('aria-label')!.includes('ahead … behind …'),
      );
    expect(uncounted().length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('visible='))).toBe(true),
    );
    const sent = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('visible='))!;
    expect(new URL(sent, 'http://x').searchParams.getAll('visible').length).toBeLessThan(60);
    await waitFor(() => expect(uncounted()).toHaveLength(0));
  });
});
