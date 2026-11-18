/** Parsed unified-diff line. `newLine`/`oldLine` are null where the side has no line. */
export interface DiffLine {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const m = HUNK.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      out.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null });
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newNo++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldLine: oldNo++, newLine: null });
    } else if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
    } else {
      out.push({ kind: 'context', text: raw.slice(1), oldLine: oldNo++, newLine: newNo++ });
    }
  }
  return out;
}

/** Stable DOM id for a line on the new side of a file (used by "jump to line"). */
export function lineAnchor(path: string, line: number): string {
  return `diff-${path.replace(/[^A-Za-z0-9_-]/g, '_')}-R${line}`;
}

export function fileAnchor(path: string): string {
  return `file-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Link to the Changed Files tab at a file/line of a PR page, keeping the selected review. */
export function filesTabHref(base: string, path: string, line?: number, reviewId?: string): string {
  const q = new URLSearchParams({ tab: 'files', file: path });
  if (line != null) q.set('line', String(line));
  if (reviewId) q.set('review', reviewId);
  return `${base}?${q.toString()}#${line != null ? lineAnchor(path, line) : fileAnchor(path)}`;
}
