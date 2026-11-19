/** GitHub user (`@octocat`) or team (`@org/team`) mention, not part of an email or word. */
const MENTION = /(?<![\w])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?/g;

const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|~=:]/g;

function escapePlain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MD_SPECIAL, (c) => `\\${c}`);
}

/**
 * Escapes untrusted (AI / ingest) text for GitHub markdown: neutralises HTML and markdown syntax, and
 * wraps `@mentions` in backticks so the bot never pings people or teams.
 */
export function escapeMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  let out = '';
  let last = 0;
  for (const m of normalized.matchAll(MENTION)) {
    out += escapePlain(normalized.slice(last, m.index)) + '`' + m[0] + '`';
    last = m.index + m[0].length;
  }
  return out + escapePlain(normalized.slice(last));
}

/** Escapes and collapses to one line (for titles, list items, table cells). */
export function escapeInline(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, ' ').trim());
}

/** A code fence longer than any backtick run inside `content`, so the content cannot close it. */
export function fenceFor(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}
