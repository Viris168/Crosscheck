// @vitest-environment jsdom
import { GetTreeResponse, type TreeSnapshot } from '@app/shared/client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { seedBranches, seedSnapshot, SEED_SHA } from './__fixtures__/seed-snapshot';
import { BranchTree } from './branch-tree';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

function tree(over: Partial<GetTreeResponse> = {}, snapshot: TreeSnapshot | null = seedSnapshot()) {
  return GetTreeResponse.parse({
    status: 'ready',
    syncedAt: '2026-11-20T10:00:00.000Z',
    errorCode: null,
    snapshot,
    canEdit: false,
    ...over,
  });
}

/** fetch mock: GET /tree → `body`; POST /tree/sync → `sync`. */
function serve(body: GetTreeResponse, sync: Response = Response.json({ queued: true })) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === 'POST' ? sync.clone() : Response.json(body),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const render = () => renderWithQuery(<BranchTree repoId="r1" repoFullName="acme/web" />);
const branchRow = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^Branch ${name.replace('/', '\\/')},`) });
/** Unfolds the merged branches compared with `parent` (folded by default, T6b). */
const openMerged = async (parent = 'main') =>
  userEvent.click(
    await screen.findByRole('button', {
      name: new RegExp(`merged branch(es)? compared with ${parent}$`),
    }),
  );
const rowOrder = () =>
  screen
    .getAllByRole('button', { name: /^Branch / })
    .map((el) => el.getAttribute('aria-label')!.match(/^Branch ([^,]+),/)![1]);

describe('BranchTree with the seed snapshot', () => {
  it('nests stacked branches under their compare-with branch', async () => {
    serve(tree());
    render();
    await screen.findByRole('group', { name: /Repository tree/ });
    // Merged branches fold into one row under their parent (T6b); unfolding adds them back.
    expect(rowOrder()).toEqual([
      'main',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
    ]);
    await openMerged();
    expect(rowOrder()).toEqual([
      'main',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
      'chore/readme',
    ]);
    expect(branchRow('feature/login').getAttribute('aria-label')).toContain(
      'ahead 3 behind 1 vs dev · PR #2',
    );
    expect(screen.getByRole('button', { name: /^Repository web, 6 branches/ })).toBeTruthy();
  });

  it('renders the merged line and CI dot for open PRs only', async () => {
    serve(tree());
    render();
    await openMerged();
    const readme = await waitFor(() => branchRow('chore/readme'));
    expect(within(readme).getByText('merged via #1 (squash)')).toBeTruthy();
    expect(readme.querySelector('[data-ci]')).toBeNull(); // PR #1 is merged
    expect(branchRow('hotfix/header').querySelector('[data-ci]')?.getAttribute('data-ci')).toBe(
      'failure',
    );
    expect(branchRow('feature/login').querySelector('[data-ci]')?.getAttribute('data-ci')).toBe(
      'success',
    );
  });

  it('renders the same-commit label', async () => {
    const s = seedSnapshot({
      branches: seedBranches.map((b) =>
        b.name === 'hotfix/header'
          ? { ...b, headSha: SEED_SHA.c4!, ahead: 0, pr: null, why: 'inferred', whyPr: null }
          : b,
      ),
    });
    serve(tree({}, s));
    render();
    const row = await waitFor(() => branchRow('hotfix/header'));
    expect(within(row).getByText('same commit as main')).toBeTruthy();
  });

  it('draws the squash merge commit as a square', async () => {
    serve(tree());
    render();
    const c4 = await screen.findByRole('button', { name: /^Commit c4c4c4c/ });
    expect(c4.getAttribute('data-shape')).toBe('squash');
  });

  it('draws heads with a double ring and merge commits filled', async () => {
    serve(tree());
    render();
    const head = await screen.findByRole('button', {
      name: /^Commit f3f3f3f, head of feature\/login$/,
    });
    expect(head.getAttribute('data-head')).toBe('true');
    expect(head.querySelectorAll('circle')).toHaveLength(2);
  });

  it('shows branch details on click, commit details without a message', async () => {
    serve(tree());
    render();
    await userEvent.click(await waitFor(() => branchRow('feature/login')));
    const aside = screen.getByRole('complementary');
    expect(within(aside).getByText('Target of PR #2 (open).')).toBeTruthy();
    expect(within(aside).getByRole('link', { name: '#2' }).getAttribute('href')).toBe(
      '/repos/r1/pulls/2',
    );

    await userEvent.click(screen.getByRole('button', { name: /^Commit d2d2d2d/ }));
    expect(within(aside).getByText('Normal commit')).toBeTruthy();
    expect(
      within(aside)
        .getByRole('link', { name: /View on GitHub/ })
        .getAttribute('href'),
    ).toBe(`https://github.com/acme/web/commit/${SEED_SHA.d2}`);
    expect(within(aside).getByRole('button', { name: 'Commit d1d1d1d' })).toBeTruthy(); // parent
  });

  it('is read-only: no commit, branch, PR, merge or CI controls', async () => {
    serve(tree());
    render();
    await userEvent.click(await waitFor(() => branchRow('feature/login')));
    // (`Merged` alone is the filter chip, T6b.)
    for (const name of [/^Commit$/, /Create/, /Open PR/, /^Merge(?!d$)/, /Run CI/, /Delete/])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText(/Acting as/)).toBeNull();
    expect(screen.queryByText(/real parents/)).toBeNull();
  });

  it('Enter on a row with a PR opens the PR page; Enter elsewhere selects', async () => {
    serve(tree());
    render();
    const row = await waitFor(() => branchRow('hotfix/header'));
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith('/repos/r1/pulls/3');

    branchRow('dev').focus();
    await userEvent.keyboard('{Enter}');
    expect(push).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole('complementary')).getByText(/Guessed from the commit graph/),
    ).toBeTruthy();
  });
});

describe('Full screen', () => {
  it('the button fills the window with the tree; the button or Esc brings it back', async () => {
    serve(tree());
    render();
    await screen.findByRole('group', { name: /Repository tree/ });
    const screenEl = screen.getByTestId('tree-screen');
    expect(screenEl.hasAttribute('data-full')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(screenEl.hasAttribute('data-full')).toBe(true);
    expect(screen.getByTestId('tree-scroller').style.maxHeight).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(screenEl.hasAttribute('data-full')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await userEvent.keyboard('{Escape}');
    expect(screenEl.hasAttribute('data-full')).toBe(false);
  });
});

describe('BranchTree states', () => {
  it('syncing without a snapshot: skeleton + "Cloning commits…"', async () => {
    serve(tree({ status: 'syncing', syncedAt: null }, null));
    render();
    expect(await screen.findByText('Cloning commits…')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Repository tree/ })).toBeNull();
  });

  it('failed: shows the error and "Try again" posts a sync', async () => {
    const fetchMock = serve(tree({ status: 'failed', errorCode: 'github_error' }, null));
    render();
    expect(await screen.findByText(/Could not build the branch tree/)).toBeTruthy();
    expect(screen.getByText(/GitHub did not answer/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/repos/r1/tree/sync',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('Refresh posts a sync; a 429 is explained', async () => {
    const fetchMock = serve(
      tree(),
      Response.json({ error: { code: 'rate_limited', message: 'slow down' } }, { status: 429 }),
    );
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/less than a minute ago/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repos/r1/tree/sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('empty: only the default branch', async () => {
    serve(tree({}, seedSnapshot({ branches: [seedBranches[0]!] })));
    render();
    expect(await screen.findByText(/Only the default branch so far/)).toBeTruthy();
  });

  it('truncated banner', async () => {
    serve(tree({}, seedSnapshot({ truncated: true })));
    render();
    expect(await screen.findByText(/only part of its history is drawn/)).toBeTruthy();
  });
});

describe('Compare with (T4)', () => {
  /** GET → `body`; PUT /compare-with → `put()` (call it to control timing). */
  function serveEdit(body: GetTreeResponse, put: () => Promise<Response>) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? put() : Response.json(body),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const select = () =>
    screen.getByRole('combobox', { name: 'Compare feature/login-oauth with' }) as HTMLSelectElement;

  it('shows the why label in each row and the long form in the details', async () => {
    serve(tree());
    render();
    expect((await waitFor(() => branchRow('dev'))).getAttribute('aria-label')).toContain(
      'vs main · guess',
    );
    await openMerged();
    await userEvent.click(branchRow('chore/readme'));
    expect(
      within(screen.getByRole('complementary')).getByText('Target of PR #1 (merged).'),
    ).toBeTruthy();
  });

  it('is hidden without write access and for the default branch', async () => {
    serve(tree());
    render();
    await userEvent.click(await waitFor(() => branchRow('feature/login-oauth')));
    expect(screen.queryByRole('combobox', { name: /with$/ })).toBeNull();
  });

  it('lists Automatic + every other branch; default branch has no select', async () => {
    serve(tree({ canEdit: true }));
    render();
    await userEvent.click(await waitFor(() => branchRow('main')));
    expect(screen.queryByRole('combobox', { name: /with$/ })).toBeNull();
    await userEvent.click(branchRow('feature/login-oauth'));
    expect([...select().options].map((o) => o.text)).toEqual([
      'Automatic (PR target, record or guess)',
      'main',
      'chore/readme',
      'dev',
      'feature/login',
      'hotfix/header',
    ]);
    expect(select().value).toBe('');
  });

  it('updates optimistically, then takes the server answer', async () => {
    let answer!: (r: Response) => void;
    const oauth = seedBranches.find((b) => b.name === 'feature/login-oauth')!;
    const saved = { ...oauth, compareWith: 'feature/login', why: 'override' as const, ahead: 1 };
    let body = tree({ canEdit: true });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? new Promise<Response>((r) => (answer = r)) : Response.json(body),
    );
    vi.stubGlobal('fetch', fetchMock);
    render();
    await userEvent.click(await waitFor(() => branchRow('feature/login-oauth')));
    await userEvent.selectOptions(select(), 'feature/login');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repos/r1/tree/compare-with',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ branch: 'feature/login-oauth', compareWith: 'feature/login' }),
      }),
    );
    await waitFor(() =>
      expect(branchRow('feature/login-oauth').getAttribute('aria-label')).toContain(
        'vs feature/login · set by hand',
      ),
    );
    expect(screen.getByText('Set by hand below.')).toBeTruthy();

    // The server stored it: later GETs (the refetch after the mutation) include it too.
    body = tree(
      { canEdit: true },
      seedSnapshot({ branches: seedBranches.map((b) => (b.name === oauth.name ? saved : b)) }),
    );
    answer(Response.json({ branch: saved }));
    await waitFor(() =>
      expect(branchRow('feature/login-oauth').getAttribute('aria-label')).toContain(
        'ahead 1 behind 1 vs feature/login · set by hand',
      ),
    );
  });

  it('rolls back and explains when the server refuses (loop)', async () => {
    serveEdit(tree({ canEdit: true }), async () =>
      Response.json(
        { error: { code: 'bad_request', message: 'That would make a loop.' } },
        { status: 400 },
      ),
    );
    render();
    await userEvent.click(await waitFor(() => branchRow('feature/login-oauth')));
    await userEvent.selectOptions(select(), 'feature/login');
    expect(await screen.findByText('That would make a loop.')).toBeTruthy();
    expect(branchRow('feature/login-oauth').getAttribute('aria-label')).toContain(
      'ahead 3 behind 1 vs dev · guess',
    );
    expect(select().value).toBe('');
  });
});
