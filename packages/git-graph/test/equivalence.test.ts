import { describe, expect, it } from 'vitest';
import { contentMerged, equivalence, matchPatchIds, mergedByContent } from '../src';

describe('matchPatchIds (git cherry)', () => {
  it('marks branch commits whose patch id is in the target', () => {
    const lines = matchPatchIds(
      new Map([
        ['b1', 'P1'],
        ['b2', 'P2'],
      ]),
      new Map([
        ['t1', 'P1'],
        ['t2', 'PX'],
      ]),
    );
    expect(lines).toEqual([
      { sha: 'b1', equivalent: true, twin: 't1' },
      { sha: 'b2', equivalent: false, twin: null },
    ]);
  });
});

describe('contentMerged', () => {
  it('is true only when the merge tree equals the target tree', () => {
    expect(contentMerged('T', 'T')).toBe(true);
    expect(contentMerged('M', 'T')).toBe(false);
    expect(contentMerged(null, 'T')).toBe(false);
  });
});

describe('equivalence / mergedByContent (prototype contentMerged)', () => {
  const isMerge = (s: string) => s.startsWith('m');
  it('all patch matches → rebased', () => {
    expect(
      mergedByContent({
        ahead: ['a', 'b'],
        isMerge,
        patchMatched: ['a', 'b'],
        contentInTarget: false,
      }),
    ).toBe('rebased');
  });
  it('rest in target by content → squashed', () => {
    const input = { ahead: ['a', 'm1', 'b'], isMerge, patchMatched: ['a'], contentInTarget: true };
    expect(equivalence(input).map((e) => e.kind)).toEqual(['patch', 'merge', 'content']);
    expect(mergedByContent(input)).toBe('squashed');
  });
  it('anything new → not merged; nothing ahead → not marked', () => {
    expect(
      mergedByContent({ ahead: ['a', 'b'], isMerge, patchMatched: ['a'], contentInTarget: false }),
    ).toBeNull();
    expect(
      mergedByContent({ ahead: [], isMerge, patchMatched: [], contentInTarget: true }),
    ).toBeNull();
  });
  it('only merge commits ahead → rebased (prototype: merges count as done)', () => {
    expect(
      mergedByContent({ ahead: ['m1'], isMerge, patchMatched: [], contentInTarget: false }),
    ).toBe('rebased');
  });
});
