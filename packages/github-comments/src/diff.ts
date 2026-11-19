const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * New-file (RIGHT side) line numbers that a review comment can target: added lines and context lines.
 * Removed lines only exist on the LEFT side and are excluded.
 */
export function rightSideLines(patch: string | null | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let next: number | undefined;
  for (const raw of patch.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(text);
    if (header) {
      next = Number(header[1]);
      continue;
    }
    if (next === undefined) continue; // before the first hunk (e.g. `diff --git` lines)
    // '+' added, ' ' context: both exist on the RIGHT side. '-' removed and the "No newline" marker do not.
    if (text.startsWith('+') || text.startsWith(' ')) {
      lines.add(next);
      next += 1;
    }
  }
  return lines;
}

/** True when `line` (new-file line number) can carry a RIGHT-side review comment for this patch. */
export function isLineInDiff(patch: string | null | undefined, line: number): boolean {
  if (!Number.isInteger(line) || line < 1) return false;
  return rightSideLines(patch).has(line);
}
