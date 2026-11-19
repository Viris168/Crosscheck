// Pure planning helpers for review-start: which files to send to the AI, and how to chunk them.
// No I/O here, so both the `plan` step and every `chunk-<i>` step compute exactly the same thing.
import { LIMITS, type ReviewFile } from '@app/shared';

/** Rough token estimate (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------- filtering

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'pipfile.lock',
  'go.sum',
]);

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return (i === -1 ? path : path.slice(i + 1)).toLowerCase();
}

/** `.env*`, `*.pem`, `*.key` — never sent to an AI provider. */
export function isSecretLike(path: string): boolean {
  const name = basename(path);
  return name.startsWith('.env') || name.endsWith('.pem') || name.endsWith('.key');
}

export function isLockfile(path: string): boolean {
  const name = basename(path);
  return LOCKFILES.has(name) || name.endsWith('.lock');
}

/** Minimal glob → RegExp: `**` (any dirs), `*` (within a segment), `?`. Matches the whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = zero or more directories; a trailing `**` = anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Files we may review: drops removed, binary/no patch, ignored, secret-like and lockfiles. */
export function reviewableFiles(
  files: readonly ReviewFile[],
  ignorePaths: readonly string[],
): ReviewFile[] {
  return files.filter(
    (f) =>
      f.status !== 'removed' &&
      f.patch.trim() !== '' &&
      !isSecretLike(f.path) &&
      !isLockfile(f.path) &&
      !matchesAny(f.path, ignorePaths),
  );
}

// ---------------------------------------------------------------- truncation

/**
 * A patch that fits in `maxTokens`: whole hunks from the start, then a `\` note line (diff syntax for
 * "not a content line", like `\ No newline at end of file`). If even the first hunk is too big it is cut
 * at a line boundary.
 */
export function truncatePatch(
  patch: string,
  maxTokens: number,
): { patch: string; truncated: boolean } {
  if (estimateTokens(patch) <= maxTokens) return { patch, truncated: false };
  const note = '\\ Truncated by the reviewer: the rest of this file was not reviewed (too large).';
  const budget = Math.max(0, maxTokens * 4 - note.length - 1);

  const hunks = patch.split(/(?=^@@ )/m);
  let kept = '';
  for (const h of hunks) {
    if (kept.length + h.length > budget) break;
    kept += h;
  }
  if (kept === '') {
    const cut = patch.slice(0, budget);
    const nl = cut.lastIndexOf('\n');
    kept = nl > 0 ? cut.slice(0, nl + 1) : cut;
  }
  if (!kept.endsWith('\n')) kept += '\n';
  return { patch: kept + note, truncated: true };
}

/** The file as it is sent to the provider (truncated if larger than one chunk). */
export function prepareFile(
  file: ReviewFile,
  chunkTokens: number = LIMITS.chunkTokens,
): ReviewFile {
  return { ...file, patch: truncatePatch(file.patch, chunkTokens).patch };
}

// ---------------------------------------------------------------- prioritisation + chunking

const RISKY_PATH = /auth|payment|billing|migration|security|config/i;

export function isRiskyPath(path: string): boolean {
  return RISKY_PATH.test(path);
}

export interface ReviewPlan {
  /** File paths per chunk. Never patches: this is returned from a step and persisted by Inngest. */
  chunks: string[][];
  filesTotal: number;
  /** Reviewable files left out because the PR exceeded the total token budget. */
  skippedFiles: number;
  /** Files cut to their first hunks. */
  truncatedFiles: number;
  tooLarge: boolean;
}

export function planChunks(
  files: readonly ReviewFile[],
  limits: { chunkTokens: number; totalTokens: number } = LIMITS,
): ReviewPlan {
  const sized = files.map((f, index) => {
    const prepared = prepareFile(f, limits.chunkTokens);
    return {
      path: f.path,
      index,
      tokens: estimateTokens(prepared.patch),
      truncated: prepared.patch !== f.patch,
    };
  });

  const total = sized.reduce((n, f) => n + f.tokens, 0);
  const tooLarge = total > limits.totalTokens;

  let kept = sized;
  if (tooLarge) {
    // Riskiest paths first, then original order; take what fits in the total budget.
    const ordered = [...sized].sort(
      (a, b) => Number(isRiskyPath(b.path)) - Number(isRiskyPath(a.path)) || a.index - b.index,
    );
    let used = 0;
    kept = [];
    for (const f of ordered) {
      if (used + f.tokens > limits.totalTokens) continue;
      used += f.tokens;
      kept.push(f);
    }
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const f of kept) {
    if (current.length > 0 && currentTokens + f.tokens > limits.chunkTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(f.path);
    currentTokens += f.tokens;
  }
  if (current.length > 0) chunks.push(current);

  return {
    chunks,
    filesTotal: kept.length,
    skippedFiles: sized.length - kept.length,
    truncatedFiles: kept.filter((f) => f.truncated).length,
    tooLarge,
  };
}
