import { describe, expect, it } from 'vitest';
import { changedRanges, filesTabHref, lineAnchor, parsePatch } from './diff';

describe('parsePatch', () => {
  it('numbers old/new lines across hunks', () => {
    const lines = parsePatch(
      '@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new1\n+new2\n ctx2\n\\ No newline at end of file',
    );
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['hunk', null, null],
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
      ['meta', null, null],
    ]);
    expect(lines[3]?.text).toBe('new1');
  });

  it('handles new files', () => {
    const lines = parsePatch('@@ -0,0 +1,2 @@\n+a\n+b');
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.newLine)).toEqual([1, 2]);
  });
});

describe('anchors', () => {
  it('are DOM-safe and stable', () => {
    expect(lineAnchor('src/a b/c.ts', 3)).toBe('diff-src_a_b_c_ts-R3');
  });

  it('filesTabHref keeps the review id', () => {
    expect(filesTabHref('/p', 'a.ts', 2, 'rev')).toBe(
      '/p?tab=files&file=a.ts&line=2&review=rev#diff-a_ts-R2',
    );
    expect(filesTabHref('/p', 'a.ts')).toBe('/p?tab=files&file=a.ts#file-a_ts');
  });
});

describe('changedRanges', () => {
  it('pairs deleted/added lines in a block and marks only the changed middle', () => {
    const lines = parsePatch(
      '@@ -1,3 +1,3 @@\n ctx\n-  return "Hello, " + name;\n+  return `Hello, ${name}!`;\n-gone\n',
    );
    const ranges = changedRanges(lines);
    // del at index 2, add at index 3: shared prefix "  return " and suffix ";"
    expect(ranges.get(2)).toEqual([9, 25]);
    expect(ranges.get(3)).toEqual([9, 26]);
    expect(ranges.has(4)).toBe(false); // unpaired deletion
  });

  it('pairs by similarity when an inserted line shifts the block', () => {
    const lines = parsePatch(
      '@@ -1,2 +1,3 @@\n-function greet(name) {\n-  return "Hi " + name;\n+// docs\n+function greet(name: string) {\n+  return `Hi ${name}`;',
    );
    const ranges = changedRanges(lines);
    expect(ranges.has(3)).toBe(false); // the inserted comment
    expect(ranges.get(1)).toEqual([19, 19]); // "function greet(name" | ": string" | ") {"
    expect(ranges.get(4)).toEqual([19, 27]);
    expect(ranges.has(2) && ranges.has(5)).toBe(true);
  });

  it('skips pairs with nothing in common', () => {
    expect(changedRanges(parsePatch('@@ -1 +1 @@\n-abc\n+xyz')).size).toBe(0);
  });
});
