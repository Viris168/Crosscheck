import { describe, expect, it } from 'vitest';
import { highlightLine, languageFor, markRange } from './highlight';

describe('languageFor', () => {
  it('maps extensions, unknown → undefined', () => {
    expect(languageFor('src/a.ts')).toBe('typescript');
    expect(languageFor('src/users.JS')).toBe('javascript');
    expect(languageFor('README')).toBeUndefined();
  });
});

describe('highlightLine', () => {
  it('returns plain-text segments with scopes that join back to the line', () => {
    const line = 'const s = "<b>" && 1; // hi';
    const segs = highlightLine(line, 'javascript');
    expect(segs.map((s) => s.text).join('')).toBe(line);
    expect(segs.find((s) => s.text === 'const')?.cls).toBe('hljs-keyword');
    expect(segs.find((s) => s.text === '"<b>"')?.cls).toBe('hljs-string');
    expect(segs.find((s) => s.text === '// hi')?.cls).toBe('hljs-comment');
  });

  it('without a language: one plain segment', () => {
    expect(highlightLine('x < y', undefined)).toEqual([{ text: 'x < y', cls: '' }]);
  });
});

describe('markRange', () => {
  it('splits segments at the range edges', () => {
    const out = markRange(
      [
        { text: 'return ', cls: 'k' },
        { text: '"Hello"', cls: 's' },
      ],
      [3, 9],
    );
    expect(out).toEqual([
      { text: 'ret', cls: 'k', mark: false },
      { text: 'urn ', cls: 'k', mark: true },
      { text: '"H', cls: 's', mark: true },
      { text: 'ello"', cls: 's', mark: false },
    ]);
  });
});
