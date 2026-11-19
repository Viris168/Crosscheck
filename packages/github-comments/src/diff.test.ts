import { describe, expect, it } from 'vitest';
import { isLineInDiff, rightSideLines } from './diff';

const multiHunk = [
  '@@ -1,4 +1,5 @@',
  ' import a from "a";', // 1
  '-import b from "b";',
  '+import b from "bb";', // 2
  '+import c from "c";', // 3
  ' ', // 4 (empty context line)
  ' export {};', // 5
  '@@ -20,3 +21,2 @@ function foo() {',
  ' const x = 1;', // 21
  '-const y = 2;',
  '-const z = 3;',
  '+const yz = 5;', // 22
  '\\ No newline at end of file',
].join('\n');

describe('isLineInDiff', () => {
  it('collects added and context lines across hunks', () => {
    expect([...rightSideLines(multiHunk)]).toEqual([1, 2, 3, 4, 5, 21, 22]);
  });

  it.each([
    [1, true], // context
    [2, true], // added
    [3, true],
    [6, false], // between hunks
    [20, false],
    [21, true],
    [22, true],
    [23, false], // past the last hunk
    [0, false],
    [-1, false],
    [2.5, false],
  ])('line %s → %s', (line, expected) => {
    expect(isLineInDiff(multiHunk, line)).toBe(expected);
  });

  it('removed lines do not advance new-file numbers', () => {
    const patch = '@@ -10,3 +10,1 @@\n-a\n-b\n+c';
    expect(isLineInDiff(patch, 10)).toBe(true);
    expect(isLineInDiff(patch, 11)).toBe(false);
  });

  it('a removed file has no RIGHT-side lines', () => {
    expect(rightSideLines('@@ -1,2 +0,0 @@\n-a\n-b').size).toBe(0);
  });

  it('a new file counts from 1', () => {
    expect([...rightSideLines('@@ -0,0 +1,3 @@\n+a\n+b\n+c\n')]).toEqual([1, 2, 3]);
  });

  it('hunk headers without counts', () => {
    expect(isLineInDiff('@@ -1 +1 @@\n-a\n+b', 1)).toBe(true);
  });

  it('a pure rename has an empty patch → nothing commentable', () => {
    expect(isLineInDiff('', 1)).toBe(false);
    expect(isLineInDiff(undefined, 1)).toBe(false);
  });

  it('a renamed file with edits uses the new file line numbers', () => {
    const patch =
      'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n@@ -5,2 +5,3 @@\n keep\n+added\n keep2';
    expect([...rightSideLines(patch)]).toEqual([5, 6, 7]);
  });

  it('handles CRLF patches', () => {
    expect([...rightSideLines('@@ -1,1 +1,2 @@\r\n a\r\n+b\r\n')]).toEqual([1, 2]);
  });
});
