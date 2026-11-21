import { CommitGraph, type CommitInput } from '../src';

/** `dag('a', 'b:a', 'c:a', 'm:b,c')` → commits named by their SHA, one minute apart, in the given order. */
export function dag(...specs: string[]): CommitGraph {
  return new CommitGraph(commits(...specs));
}

export function commits(...specs: string[]): CommitInput[] {
  return specs.map((s, i) => {
    const [sha = '', ps = ''] = s.split(':');
    return {
      sha,
      parents: ps ? ps.split(',') : [],
      committedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    };
  });
}
