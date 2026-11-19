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

/** Lengths of the common prefix and (non-overlapping) common suffix of two strings. */
function commonEnds(a: string, b: string): [number, number] {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [pre, suf];
}

/** How much of the shorter line two lines share at their ends, ignoring leading indentation. */
function similarity(a: string, b: string): number {
  const [pre, suf] = commonEnds(a.trimStart(), b.trimStart());
  return (pre + suf) / Math.max(1, Math.min(a.trim().length, b.trim().length));
}

const MIN_SIMILARITY = 0.3;

/**
 * Within each change block (deleted lines followed by added lines), pairs each deleted line with
 * the most similar added line after the previous pair, and returns the changed `[start, end)`
 * character range of both, keyed by index into `lines`. Lines without a similar enough partner
 * get no range (the whole row is already coloured).
 */
export function changedRanges(lines: DiffLine[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (lines[i]?.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (lines[i]?.kind === 'add') adds.push(i++);
    let next = 0; // pairs keep their order: only look at adds after the last match
    for (const d of dels) {
      const a = lines[d]!.text;
      let best = -1;
      let bestScore = MIN_SIMILARITY - Number.EPSILON;
      for (let k = next; k < adds.length; k++) {
        const score = similarity(a, lines[adds[k]!]!.text);
        if (score > bestScore) [best, bestScore] = [k, score];
      }
      if (best === -1) continue;
      next = best + 1;
      const b = lines[adds[best]!]!.text;
      if (a === b) continue;
      const [pre, suf] = commonEnds(a, b);
      out.set(d, [pre, a.length - suf]);
      out.set(adds[best]!, [pre, b.length - suf]);
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
