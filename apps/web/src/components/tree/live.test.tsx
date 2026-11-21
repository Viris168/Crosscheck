// @vitest-environment jsdom
// T5c: live tree page — conditional polling (304), idle/hidden stop, row highlights, recorded badge,
// "Last updated", live-events hint.
import { GetTreeResponse, type BranchNode, type TreeSnapshot } from '@app/shared/client';
import { notifyManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_GRACE_MS, TREE_IDLE_MS, TREE_POLL_MS } from '@/hooks/use-tree';
import { renderWithQuery } from '../../../test/render';
import { fakeSha, seedBranches, seedSnapshot } from './__fixtures__/seed-snapshot';
import { BranchTree } from './branch-tree';
import { formatAgo } from './last-updated';
import { diffBranches, FLASH_MS, LEAVE_MS } from './use-row-changes';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const NOW = Date.parse('2026-11-20T10:00:10.000Z');

/** The fake server: current state + version; answers 304 when If-None-Match is the current ETag. */
const server = {
  version: 1,
  body: null as unknown as GetTreeResponse,
  live: '1',
  sync: () => Response.json({ queued: true }),
};
const etag = () => `W/"v${server.version}"`;
function setTree(over: Partial<GetTreeResponse> = {}, snapshot: TreeSnapshot = seedSnapshot()) {
  server.version++;
  server.body = GetTreeResponse.parse({
    status: 'ready',
    syncedAt: '2026-11-20T10:00:00.000Z',
    errorCode: null,
    snapshot,
    canEdit: false,
    ...over,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const gets = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST');
const lastIfNoneMatch = () => {
  const init = gets().at(-1)?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
};

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  // TanStack batches observer notifications on setTimeout(0); run them as microtasks so a polled
  // result renders inside the same act() as the fake-timer tick that fetched it.
  notifyManager.setScheduler(queueMicrotask);
  vi.useFakeTimers({
    now: NOW,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  server.version = 0;
  server.live = '1';
  setTree();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return server.sync();
    const inm = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
    const headers = { etag: etag(), 'x-tree-live-events': server.live };
    if (inm === etag()) return new Response(null, { status: 304, headers });
    return Response.json(server.body, { headers });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** One poll interval, then let fetch → json → render → effects settle. */
const poll = async () => {
  await tick(TREE_POLL_MS);
  await settle();
};
// Captured before fake timers are installed: TanStack's notify batching and body reading run on real
// macrotasks here.
const realSetTimeout = globalThis.setTimeout;
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(() => new Promise<void>((r) => realSetTimeout(r, 2)));
    await tick(0);
  }
}
// TanStack's focusManager listens on window; the real event bubbles up from document.
const visibilityChanged = () =>
  act(() => void document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

async function renderTree() {
  const r = renderWithQuery(<BranchTree repoId="r1" repoFullName="acme/web" />);
  await settle();
  return r;
}

const row = (name: string) =>
  document.querySelector(`[data-branch="${name}"]`) as SVGGElement | null;

function withBranch(name: string, patch: Partial<BranchNode>): TreeSnapshot {
  return seedSnapshot({
    branches: seedBranches.map((b) => (b.name === name ? { ...b, ...patch } : b)),
  });
}

describe('conditional polling', () => {
  it('polls every 3 s with If-None-Match; a 304 keeps the same data object', async () => {
    const { client } = await renderTree();
    expect(gets()).toHaveLength(1);
    expect(lastIfNoneMatch()).toBeUndefined();
    const first =
      client.getQueryData(['tree', 'r1']) ?? client.getQueryCache().getAll()[0]!.state.data;

    await tick(TREE_POLL_MS);
    expect(gets()).toHaveLength(2);
    expect(lastIfNoneMatch()).toBe(etag());
    const after = client.getQueryCache().getAll()[0]!.state.data;
    expect(after).toBe(first); // 304 → nothing re-parsed, nothing re-rendered
    expect(row('main')).not.toBeNull();

    await tick(TREE_POLL_MS);
    expect(gets()).toHaveLength(3);
  });

  it('a changed tree (200) replaces the data', async () => {
    await renderTree();
    setTree({}, withBranch('hotfix/header', { headSha: fakeSha('b1') }));
    await poll();
    expect(
      screen.getByRole('button', { name: /^Commit b1b1b1b.*head of hotfix\/header/ }),
    ).toBeTruthy();
  });

  it('stops polling while the tab is hidden and refetches when it is visible again', async () => {
    await renderTree();
    visibility = 'hidden';
    visibilityChanged();
    await tick(TREE_POLL_MS * 4);
    expect(gets()).toHaveLength(1);

    visibility = 'visible';
    visibilityChanged();
    await tick(0);
    expect(gets()).toHaveLength(2);
    await tick(TREE_POLL_MS);
    expect(gets()).toHaveLength(3);
  });

  it('stops after 10 min without input and resumes on focus', async () => {
    await renderTree();
    await tick(TREE_IDLE_MS + TREE_POLL_MS);
    const n = gets().length;
    await tick(TREE_POLL_MS * 5);
    expect(gets()).toHaveLength(n);

    act(() => void window.dispatchEvent(new Event('focus')));
    await tick(0);
    await tick(TREE_POLL_MS);
    expect(gets().length).toBeGreaterThan(n);
  });

  it('input keeps it polling past 10 min', async () => {
    await renderTree();
    for (let t = 0; t < TREE_IDLE_MS + 60_000; t += 60_000) {
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      await tick(60_000);
    }
    const n = gets().length;
    await tick(TREE_POLL_MS);
    expect(gets()).toHaveLength(n + 1);
  });

  it('Refresh shows "Updating…" while the server still answers 304, then gives up after the grace', async () => {
    await renderTree();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await tick(0);
    expect(screen.getByText('Updating…')).toBeTruthy();
    await tick(TREE_POLL_MS);
    expect(screen.getByText('Updating…')).toBeTruthy(); // 304 keeps the optimistic state

    await tick(SYNC_GRACE_MS);
    expect(screen.queryByText('Updating…')).toBeNull(); // validator dropped → server state wins
  });
});

describe('row changes', () => {
  it('flashes a row whose head moved, for 2 s', async () => {
    await renderTree();
    expect(document.querySelector('[data-flash]')).toBeNull(); // first render animates nothing

    setTree({}, withBranch('hotfix/header', { headSha: fakeSha('b1') }));
    await poll();
    expect(row('hotfix/header')!.getAttribute('data-flash')).toBe('true');
    expect(row('hotfix/header')!.classList.contains('bt-flash')).toBe(true);
    expect(row('main')!.hasAttribute('data-flash')).toBe(false);

    await tick(FLASH_MS);
    expect(row('hotfix/header')!.hasAttribute('data-flash')).toBe(false);
  });

  it('a count-only change does not flash', async () => {
    await renderTree();
    setTree({}, withBranch('hotfix/header', { behind: 9 }));
    await tick(TREE_POLL_MS);
    expect(document.querySelector('[data-flash]')).toBeNull();
  });

  it('a new branch slides in; a deleted one fades out, then is gone', async () => {
    await renderTree();
    const snap = seedSnapshot();
    setTree(
      {},
      {
        ...snap,
        branches: [
          ...snap.branches.filter((b) => b.name !== 'feature/login-oauth'),
          { ...snap.branches.find((b) => b.name === 'hotfix/header')!, name: 'hotfix/footer' },
        ],
      },
    );
    await poll();
    // Phase 1: old tree, deleted row fading
    expect(row('feature/login-oauth')!.getAttribute('data-leaving')).toBe('true');
    expect(row('hotfix/footer')).toBeNull();

    await tick(LEAVE_MS);
    expect(row('feature/login-oauth')).toBeNull();
    expect(row('hotfix/footer')!.getAttribute('data-entering')).toBe('true');
    expect(row('hotfix/footer')!.classList.contains('bt-enter')).toBe(true);
  });

  it('diffBranches finds changed, added and removed by name and head', () => {
    const a = seedSnapshot();
    const b = withBranch('dev', { headSha: fakeSha('a1') });
    b.branches = [...b.branches.filter((x) => x.name !== 'main'), { ...b.branches[0]!, name: 'x' }];
    const d = diffBranches(a, b);
    expect([...d.changed]).toEqual(['dev']);
    expect([...d.added]).toEqual(['x']);
    expect([...d.removed]).toEqual(['main']);
  });
});

describe('recorded badge', () => {
  it('shows on recorded branches with the tooltip', async () => {
    setTree({}, withBranch('feature/login-oauth', { recorded: true }));
    await renderTree();
    const badge = row('feature/login-oauth')!.querySelector('[data-recorded]')!;
    expect(badge.textContent).toContain('recorded');
    expect(badge.querySelector('title')!.textContent).toBe(
      'Parent recorded when the branch was created',
    );
    expect(row('dev')!.querySelector('[data-recorded]')).toBeNull();
    expect(
      screen.getByRole('button', { name: /^Branch feature\/login-oauth,.*parent recorded/ }),
    ).toBeTruthy();
  });

  it('shows in the details panel too', async () => {
    setTree({}, withBranch('feature/login-oauth', { recorded: true }));
    await renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Branch feature\/login-oauth,/ }));
    expect(screen.getByTitle('Parent recorded when the branch was created').textContent).toBe(
      'recorded',
    );
  });
});

describe('header and hint', () => {
  it('"Last updated Xs ago" next to Refresh, ticking', async () => {
    await renderTree();
    expect(screen.getByText(/Last updated/).textContent).toBe('Last updated 10s ago');
    await tick(5000);
    expect(screen.getByText(/Last updated/).textContent).toBe('Last updated 15s ago');
  });

  it('formatAgo', () => {
    expect(formatAgo(-5000)).toBe('0s ago');
    expect(formatAgo(59_999)).toBe('59s ago');
    expect(formatAgo(60_000)).toBe('1m ago');
    expect(formatAgo(3 * 3600_000)).toBe('3h ago');
    expect(formatAgo(49 * 3600_000)).toBe('2d ago');
  });

  it('hints at the App permissions when no git events arrived for the repo', async () => {
    server.live = '0';
    await renderTree();
    const hint = screen.getByTestId('live-hint');
    expect(hint.textContent).toContain('refreshes every 15 minutes');
    expect(hint.querySelector('a')!.getAttribute('href')).toContain('docs.github.com');
  });

  it('no hint when git events arrive', async () => {
    await renderTree();
    expect(screen.queryByTestId('live-hint')).toBeNull();
  });
});
