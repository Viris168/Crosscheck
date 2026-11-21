import { describe, expect, it } from 'vitest';
import { CommitGraph, UnknownCommitError } from '../src';
import { commits, dag } from './helpers';

describe('CommitGraph', () => {
  const g = dag('a', 'b:a', 'c:b', 'd:b', 'e:c,d', 'f:a');

  it('counts ahead/behind like rev-list --count', () => {
    expect(g.aheadBehind('e', 'f')).toEqual({ ahead: 4, behind: 1 });
    expect(g.aheadBehind('f', 'e')).toEqual({ ahead: 1, behind: 4 });
    expect(g.aheadBehind('c', 'c')).toEqual({ ahead: 0, behind: 0 });
  });

  it('lists ahead commits parents first', () => {
    expect(g.aheadCommits('e', 'a')).toEqual(['b', 'c', 'd', 'e']);
    expect(g.reachable('d')).toEqual(['a', 'b', 'd']);
  });

  it('answers ancestry', () => {
    expect(g.isAncestor('a', 'e')).toBe(true);
    expect(g.isAncestor('e', 'e')).toBe(true);
    expect(g.isAncestor('f', 'e')).toBe(false);
    expect(g.isMerge('e')).toBe(true);
    expect(g.isMerge('d')).toBe(false);
  });

  it('finds best merge bases, including criss-cross', () => {
    expect(g.mergeBases('c', 'd')).toEqual(['b']);
    expect(g.mergeBase('e', 'f')).toBe('a');
    const x = dag('r', 'p1:r', 'q1:r', 'p2:p1,q1', 'q2:q1,p1');
    expect(x.mergeBases('p2', 'q2').sort()).toEqual(['p1', 'q1']);
    expect(x.mergeBase('p2', 'q2')).toBe('q1'); // newest first
    expect(dag('a', 'b').mergeBase('a', 'b')).toBeNull();
  });

  it('keeps going on deep histories (no recursion)', () => {
    const n = 200_000;
    const list = Array.from({ length: n }, (_, i) => ({
      sha: `c${i}`,
      parents: i ? [`c${i - 1}`] : [],
      committedAt: new Date(i * 1000).toISOString(),
    }));
    const deep = new CommitGraph(list);
    expect(deep.aheadBehind(`c${n - 1}`, 'c10')).toEqual({ ahead: n - 11, behind: 0 });
    expect(deep.mergeBase(`c${n - 1}`, 'c10')).toBe('c10');
    expect(deep.aheadCommits(`c${n - 1}`, `c${n - 3}`)).toEqual([`c${n - 2}`, `c${n - 1}`]);
  });

  it('ignores missing parents and flags them; throws on unknown SHAs', () => {
    const cut = new CommitGraph(commits('b:a', 'c:b'));
    expect(cut.hasMissingParents).toBe(true);
    expect(cut.aheadBehind('c', 'b')).toEqual({ ahead: 1, behind: 0 });
    expect(() => cut.aheadBehind('c', 'zz')).toThrow(UnknownCommitError);
    expect(g.hasMissingParents).toBe(false);
  });

  it('dedupes repeated commits', () => {
    const d = new CommitGraph([...commits('a', 'b:a'), ...commits('a')]);
    expect(d.size).toBe(2);
  });
});
