// Compact binary form of a CommitGraph (T6a "graph cache"), so the API can answer without re-running
// `git log`. Ids only: SHAs, parent indexes, commit times. No ref names (only a hash of the ref set,
// which the reader compares to decide whether the file is stale). Pure: the file I/O lives in
// '@app/git-graph/git' (`saveGraph` / `loadGraph`).
//
// Layout (all integers little-endian):
//   0  "GGRF"            magic
//   4  u32 version       1
//   8  u32 flags         bit 0 = hasMissingParents
//  12  u32 shaBytes      20 (SHA-1) or 32 (SHA-256)
//  16  u32 n             commits
//  20  u32 m             parent edges
//  24  32 bytes          ref-set hash (caller-defined, e.g. sha256 of "name sha" lines)
//  56  n × shaBytes      SHAs
//      i32 × (n + 1)     parentStart (CSR offsets into parentList)
//      i32 × m           parentList (commit indexes)
//      u32 × n           commit times, seconds since epoch
import { CommitGraph } from './graph';

const MAGIC = 0x46524747; // "GGRF" read as little-endian u32
const VERSION = 1;
const HEADER = 56;

export class GraphFormatError extends Error {
  constructor(message: string) {
    super(`Bad graph file: ${message}`);
    this.name = 'GraphFormatError';
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

function hexToBytes(hex: string, out: Uint8Array, at: number, len: number): boolean {
  if (hex.length !== len * 2) return false;
  for (let i = 0; i < len; i++) {
    const hi = hexValue(hex.charCodeAt(2 * i));
    const lo = hexValue(hex.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return false;
    out[at + i] = (hi << 4) | lo;
  }
  return true;
}

function bytesToHex(bytes: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += HEX[bytes[at + i]!]!;
  return s;
}

/**
 * Encode `graph`. `refsHash` is 64 hex chars (32 bytes), stored as is. Commit times are kept to the
 * second (what `readCommitGraph` gives anyway). Throws when a SHA is not 40 or 64 hex chars.
 */
export function serializeGraph(graph: CommitGraph, refsHash: string): Uint8Array {
  const { shas, parentStart, parentList, times, hasMissingParents } = graph.parts();
  const n = shas.length;
  const m = parentList.length;
  const shaBytes = n && shas[0]!.length === 64 ? 32 : 20;
  const shaEnd = HEADER + n * shaBytes; // multiple of 4: 56 + n·20 or n·32
  const size = shaEnd + 4 * (n + 1) + 4 * m + 4 * n;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, hasMissingParents ? 1 : 0, true);
  view.setUint32(12, shaBytes, true);
  view.setUint32(16, n, true);
  view.setUint32(20, m, true);
  if (!hexToBytes(refsHash, bytes, 24, 32)) throw new Error('refsHash must be 64 hex chars');
  for (let i = 0; i < n; i++) {
    if (!hexToBytes(shas[i]!, bytes, HEADER + i * shaBytes, shaBytes))
      throw new Error(`Commit ${i} has no ${shaBytes * 2}-hex SHA; the graph cannot be serialized`);
  }
  let o = shaEnd;
  for (let i = 0; i <= n; i++, o += 4) view.setInt32(o, parentStart[i]!, true);
  for (let i = 0; i < m; i++, o += 4) view.setInt32(o, parentList[i]!, true);
  for (let i = 0; i < n; i++, o += 4) {
    const s = Math.floor(times[i]! / 1000);
    view.setUint32(o, s > 0 && s <= 0xffffffff ? s : 0, true);
  }
  return bytes;
}

/** Decode `serializeGraph` output. Throws `GraphFormatError` on anything malformed. */
export function parseGraph(bytes: Uint8Array): { graph: CommitGraph; refsHash: string } {
  if (bytes.byteLength < HEADER) throw new GraphFormatError('too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new GraphFormatError('magic');
  if (view.getUint32(4, true) !== VERSION) throw new GraphFormatError('version');
  const hasMissingParents = (view.getUint32(8, true) & 1) === 1;
  const shaBytes = view.getUint32(12, true);
  if (shaBytes !== 20 && shaBytes !== 32) throw new GraphFormatError('sha size');
  const n = view.getUint32(16, true);
  const m = view.getUint32(20, true);
  const shaEnd = HEADER + n * shaBytes;
  if (bytes.byteLength !== shaEnd + 4 * (n + 1) + 4 * m + 4 * n)
    throw new GraphFormatError('length');
  const refsHash = bytesToHex(bytes, 24, 32);
  const shas = new Array<string>(n);
  for (let i = 0; i < n; i++) shas[i] = bytesToHex(bytes, HEADER + i * shaBytes, shaBytes);
  let o = shaEnd;
  const parentStart = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++, o += 4) parentStart[i] = view.getInt32(o, true);
  if (parentStart[0] !== 0 || parentStart[n] !== m) throw new GraphFormatError('offsets');
  for (let i = 0; i < n; i++)
    if (parentStart[i + 1]! < parentStart[i]!) throw new GraphFormatError('offsets');
  const parentList = new Int32Array(m);
  for (let i = 0; i < m; i++, o += 4) {
    const p = view.getInt32(o, true);
    if (p < 0 || p >= n) throw new GraphFormatError('parent index');
    parentList[i] = p;
  }
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++, o += 4) times[i] = view.getUint32(o, true) * 1000;
  let graph: CommitGraph;
  try {
    graph = new CommitGraph([], { shas, parentStart, parentList, times, hasMissingParents });
  } catch (e) {
    throw new GraphFormatError((e as Error).message);
  }
  return { graph, refsHash };
}
