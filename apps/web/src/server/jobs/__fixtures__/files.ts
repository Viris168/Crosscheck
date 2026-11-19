// Test-only PR file fixtures.
import type { ReviewFile } from '@app/shared';

/** Marker present in every fixture patch line, to assert patches never leak into step outputs. */
export const PATCH_MARKER = 'PATCH_CONTENT_SENTINEL';

/** One-hunk patch adding `lines` lines (~50 chars each) starting at new line 1. */
export function patchOf(lines: number, startLine = 1): string {
  const body = Array.from({ length: lines }, (_, i) =>
    `+const v${i} = '${PATCH_MARKER}-${i}';`.padEnd(50, ' '),
  );
  return [`@@ -0,0 +${startLine},${lines} @@`, ...body].join('\n');
}

export function file(
  path: string,
  lines = 10,
  status: ReviewFile['status'] = 'modified',
): ReviewFile {
  return { path, status, patch: patchOf(lines) };
}

/** 136 source files of ~1.1k tokens each (~150k tokens total) → several 60k-token chunks. */
export function pr136(): ReviewFile[] {
  return Array.from({ length: 136 }, (_, i) =>
    file(`src/module-${String(i).padStart(3, '0')}.ts`, 88),
  );
}

/** ~500k tokens: 400 plain files, then 20 risky ones at the end (must be kept first). */
export function hugePr(): ReviewFile[] {
  const plain = Array.from({ length: 400 }, (_, i) => file(`src/plain-${i}.ts`, 100));
  const risky = Array.from({ length: 20 }, (_, i) => file(`src/auth/session-${i}.ts`, 100));
  return [...plain, ...risky];
}
