import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'css',
  go: 'go',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

export function languageFor(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[ext];
}

/** A run of text with its highlight.js class (innermost scope, '' for plain) and diff mark. */
export interface Segment {
  text: string;
  cls: string;
  mark?: boolean;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]!);

/**
 * Highlights one line of code as plain segments (no HTML), so callers render text nodes only.
 * Lines are highlighted on their own: a diff shows fragments, so multi-line constructs may be
 * coloured as plain text.
 */
export function highlightLine(text: string, language: string | undefined): Segment[] {
  if (!language || !text) return [{ text, cls: '' }];
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const out: Segment[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[2] !== undefined) out.push({ text: decode(m[2]), cls: stack.at(-1) ?? '' });
    else stack.pop();
  }
  return out;
}

/** Splits segments so the characters in `[start, end)` carry `mark: true`. */
export function markRange(segments: Segment[], [start, end]: [number, number]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segEnd = pos + seg.text.length;
    const cuts = [
      pos,
      Math.min(Math.max(start, pos), segEnd),
      Math.min(Math.max(end, pos), segEnd),
    ];
    cuts.push(segEnd);
    for (let c = 0; c < 3; c++) {
      const a = cuts[c]!;
      const b = cuts[c + 1]!;
      if (b > a) out.push({ ...seg, text: seg.text.slice(a - pos, b - pos), mark: c === 1 });
    }
    pos = segEnd;
  }
  return out;
}
