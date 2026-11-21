'use client';

import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  FILTER_LABEL,
  isFiltering,
  STALE_DAYS,
  TREE_FILTERS,
  type TreeFilter,
  type TreeView,
} from './view';

const FILTER_TIP: Record<TreeFilter, string> = {
  mine: 'Branches with a pull request you opened',
  'open-pr': 'Branches with an open pull request',
  'ci-failing': 'Branches whose head commit failed CI',
  merged: 'Branches already merged',
  stale: `No new commit for more than ${STALE_DAYS} days`,
};

/** Name search (client side) and filters; both live in the URL (`?q=&f=`). */
export function TreeToolbar({
  view,
  onChange,
  shown,
  total,
}: {
  view: TreeView;
  onChange: (next: TreeView) => void;
  /** branches matching the search/filters */
  shown: number;
  total: number;
}) {
  const toggle = (f: TreeFilter) =>
    onChange({ ...view, f: view.f.includes(f) ? view.f.filter((x) => x !== f) : [...view.f, f] });
  const filtering = isFiltering(view);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="search">
      <div className="relative w-full sm:w-64">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search branches"
          placeholder="Search branches"
          value={view.q}
          onChange={(e) => onChange({ ...view, q: e.target.value })}
          className="h-8 pl-8"
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filters">
        {TREE_FILTERS.map((f) => {
          const on = view.f.includes(f);
          return (
            <Button
              key={f}
              type="button"
              size="sm"
              variant={on ? 'secondary' : 'outline'}
              aria-pressed={on}
              title={FILTER_TIP[f]}
              onClick={() => toggle(f)}
              className={cn('h-7 rounded-full px-3 text-xs', on && 'ring-1 ring-(--t-accent)')}
            >
              {FILTER_LABEL[f]}
            </Button>
          );
        })}
      </div>
      {filtering && (
        <>
          <span role="status" className="text-xs text-muted-foreground tabular-nums">
            {shown} of {total} branches
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onChange({ q: '', f: [] })}
          >
            <X aria-hidden /> Clear
          </Button>
        </>
      )}
    </div>
  );
}
