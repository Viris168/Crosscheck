// Graph cache file next to the commits-only clone: `<cacheDir>/<id>.graph` (T6a). The file holds ids only
// (SHAs, parent indexes, commit times) plus a hash of the ref set it was read for; ref names are not stored.
// A file whose ref-set hash differs from the current refs is stale and ignored, so any ref change
// (push, new or deleted branch, force push) invalidates it. Same privacy class as the clone itself.
import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitGraph } from '../core/graph';
import { parseGraph, serializeGraph } from '../core/serialize';

/** ref name → SHA (e.g. `refs/heads/main` → head SHA), as a map, record or entry list */
export type RefSet =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>
  | readonly (readonly [string, string])[];

function entries(refs: RefSet): [string, string][] {
  if (refs instanceof Map) return [...refs];
  if (Array.isArray(refs)) return refs.map(([k, v]) => [k, v]);
  return Object.entries(refs as Record<string, string>);
}

/** sha256 over the sorted "name sha" lines: equal iff the ref set is equal. */
export function refSetHash(refs: RefSet): string {
  const lines = entries(refs)
    .map(([name, sha]) => `${name} ${sha}\n`)
    .sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

function graphPath(cacheDir: string, id: string): string {
  if (!/^[\w-][\w.-]*$/.test(id) || id.includes('..')) throw new Error('Invalid graph cache id');
  return join(cacheDir, `${id}.graph`);
}

/** Write the graph for `refs` (atomic: temp file + rename). */
export async function saveGraph(
  cacheDir: string,
  id: string,
  graph: CommitGraph,
  refs: RefSet,
): Promise<void> {
  const file = graphPath(cacheDir, id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, serializeGraph(graph, refSetHash(refs)), { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The cached graph, or null when there is none, it is unreadable, or it was written for a different ref
 * set (stale). Callers rebuild with `readCommitGraph` and `saveGraph` on null.
 */
export async function loadGraph(
  cacheDir: string,
  id: string,
  refs: RefSet,
): Promise<CommitGraph | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(graphPath(cacheDir, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const { graph, refsHash } = parseGraph(bytes);
    return refsHash === refSetHash(refs) ? graph : null;
  } catch {
    return null; // corrupt or old format: rebuild
  }
}
