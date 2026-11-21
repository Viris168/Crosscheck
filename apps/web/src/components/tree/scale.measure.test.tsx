// @vitest-environment jsdom
// T6b scale measurements, page side (opt in: TREE_SCALE_MEASURE=1). jsdom has no layout or paint, so
// these are JS costs (parse, layout, React render/commit) — an upper bound on script time, not a
// browser paint timing.
//   TREE_SCALE_MEASURE=1 pnpm --filter @app/web test -- scale.measure
/* eslint-disable no-console -- prints measurements on purpose */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { scaleRepo, scaleSnapshot } from './__fixtures__/scale-repo';
import { BranchTree } from './branch-tree';
import { layoutTree, squashShas, TreeGraph } from './layout';
import { GetTreeResponse } from '@app/shared/client';
import { EMPTY_VIEW, viewRows } from './view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ms = (t: number) => `${(performance.now() - t).toFixed(1)} ms`;

describe.runIf(process.env.TREE_SCALE_MEASURE === '1')('tree scale (page)', () => {
  it('measures', async () => {
    const out: string[] = [];
    const snap = scaleSnapshot(scaleRepo());
    const json = JSON.stringify({
      status: 'ready',
      syncedAt: '2026-11-20T10:00:00.000Z',
      errorCode: null,
      snapshot: snap,
      canEdit: false,
    });

    let t = performance.now();
    GetTreeResponse.parse(JSON.parse(json));
    out.push(`client: JSON.parse + zod of ${(json.length / 1e6).toFixed(2)} MB: ${ms(t)}`);

    t = performance.now();
    const graph = new TreeGraph(snap.commits);
    out.push(`TreeGraph (${snap.commits.length} commits): ${ms(t)}`);
    const ctx = { minePrs: new Set<number>(), headTime: () => null, now: Date.now() };
    t = performance.now();
    const rows = viewRows(snap, {
      view: EMPTY_VIEW,
      ctx,
      collapsed: new Set(),
      mergedOpen: new Set(),
    });
    out.push(`viewRows (501 branches → ${rows.length} rows, merged folded): ${ms(t)}`);
    const sq = squashShas(snap);
    t = performance.now();
    layoutTree(snap, graph, sq, { rows, range: { start: 0, end: 17 } });
    out.push(`layoutTree, 17 visible rows (virtualized): ${ms(t)}`);
    t = performance.now();
    layoutTree(snap, new TreeGraph(snap.commits), sq, { rows });
    out.push(`layoutTree, all ${rows.length} rows (what an unvirtualized page would do): ${ms(t)}`);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(json, { headers: { 'content-type': 'application/json' } })),
    );
    t = performance.now();
    renderWithQuery(<BranchTree repoId="r1" repoFullName="acme/big" />);
    await screen.findByRole('button', { name: /^Repository big/ });
    out.push(`first render (fetch → parse → layout → React commit): ${ms(t)}`);
    const rendered = document.querySelectorAll('[data-branch]').length;
    out.push(
      `  rows in DOM: ${rendered}; SVG/DOM elements: ${document.querySelectorAll('*').length}`,
    );
    expect(rendered).toBeLessThan(60);

    const scroller = screen.getByTestId('tree-scroller');
    const scrollTo = async (px: number) => {
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: px });
      const last = () =>
        [...document.querySelectorAll('[data-branch]')].at(-1)?.getAttribute('data-branch');
      const before = last();
      const s = performance.now();
      await act(async () => {
        fireEvent.scroll(scroller);
      });
      await waitFor(() => expect(last()).not.toBe(before));
      return performance.now() - s;
    };
    const steps: number[] = [];
    for (let i = 1; i <= 20; i++) steps.push(await scrollTo(i * 78 * 3)); // 3 rows per step
    steps.sort((a, b) => a - b);
    out.push(
      `scroll by 3 rows ×20: median ${steps[10]!.toFixed(1)} ms, max ${steps.at(-1)!.toFixed(1)} ms`,
    );
    out.push(`jump 300 rows: ${(await scrollTo(78 * 320)).toFixed(1)} ms`);
    console.log(`\n${out.join('\n')}\n`);
    cleanup();
    vi.unstubAllGlobals();
  }, 120_000);
});
