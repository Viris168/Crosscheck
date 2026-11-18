import { describe, expect, it } from 'vitest';
import { filesTabHref, lineAnchor, parsePatch } from './diff';

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
