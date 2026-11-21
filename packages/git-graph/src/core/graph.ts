// Commit graph over SHAs, parents and commit times only (prototype: `reach`, `aheadBehind`).
// SHAs are indexed to ints; parents live in one Int32Array (CSR layout). Every walk is an explicit
// stack loop, never recursion, so deep histories cannot overflow the call stack.

export interface CommitInput {
  sha: string;
  parents: readonly string[];
  /** ISO 8601 (or anything `Date.parse` accepts) */
  committedAt: string;
}

export class UnknownCommitError extends Error {
  constructor(readonly sha: string) {
    super(`Commit ${sha} is not in the graph`);
    this.name = 'UnknownCommitError';
  }
}

type Bits = Uint32Array;
const has = (bits: Bits, i: number) => ((bits[i >>> 5]! >>> (i & 31)) & 1) === 1;
const set = (bits: Bits, i: number) => {
  bits[i >>> 5]! |= 1 << (i & 31);
};

export class CommitGraph {
  readonly size: number;
  /** true when some parent SHA was not in the input (shallow or truncated history) */
  readonly hasMissingParents: boolean;
  private readonly shas: string[] = [];
  private readonly committedAt: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly parentStart: Int32Array;
  private readonly parentList: Int32Array;
  private readonly times: Float64Array;
  private readonly words: number;
  // Commits never change, so what a commit reaches can be cached for good (prototype `reachCache`).
  private readonly reachCache = new Map<number, Bits>();
  private topoRank: Int32Array | null = null;

  constructor(commits: readonly CommitInput[]) {
    const unique: CommitInput[] = [];
    for (const c of commits) {
      if (this.index.has(c.sha)) continue;
      this.index.set(c.sha, unique.length);
      this.shas.push(c.sha);
      this.committedAt.push(c.committedAt);
      unique.push(c);
    }
    const n = unique.length;
    this.size = n;
    this.words = Math.ceil(n / 32) || 1;
    this.times = new Float64Array(n);
    this.parentStart = new Int32Array(n + 1);
    const list: number[] = [];
    let missing = false;
    for (let i = 0; i < n; i++) {
      const c = unique[i]!;
      this.times[i] = Date.parse(c.committedAt) || 0;
      this.parentStart[i] = list.length;
      for (const p of c.parents) {
        const pi = this.index.get(p);
        if (pi === undefined) missing = true;
        else list.push(pi);
      }
    }
    this.parentStart[n] = list.length;
    this.parentList = Int32Array.from(list);
    this.hasMissingParents = missing;
  }

  has(sha: string): boolean {
    return this.index.has(sha);
  }

  commit(sha: string): { sha: string; parents: string[]; committedAt: string } {
    const i = this.idx(sha);
    return {
      sha,
      parents: Array.from(this.parentsOf(i), (p) => this.shas[p]!),
      committedAt: this.committedAt[i]!,
    };
  }

  isMerge(sha: string): boolean {
    const i = this.idx(sha);
    return this.parentStart[i + 1]! - this.parentStart[i]! > 1;
  }

  /** Is `a` an ancestor of `b` (or equal)? Same as `git merge-base --is-ancestor a b`. */
  isAncestor(a: string, b: string): boolean {
    const ai = this.idx(a);
    return has(this.reach(this.idx(b)), ai);
  }

  /** ahead = `git rev-list --count b..a`, behind = `git rev-list --count a..b`. */
  aheadBehind(a: string, b: string): { ahead: number; behind: number } {
    const A = this.reach(this.idx(a));
    const B = this.reach(this.idx(b));
    let ahead = 0;
    let behind = 0;
    for (let w = 0; w < this.words; w++) {
      ahead += popcount(A[w]! & ~B[w]!);
      behind += popcount(B[w]! & ~A[w]!);
    }
    return { ahead, behind };
  }

  /** Commits in `b..a` (reachable from a, not from b), oldest first (parents before children). */
  aheadCommits(a: string, b: string): string[] {
    const A = this.reach(this.idx(a));
    const B = this.reach(this.idx(b));
    const out: number[] = [];
    for (let w = 0; w < this.words; w++) {
      let bits = A[w]! & ~B[w]!;
      while (bits) {
        const low = bits & -bits;
        out.push(w * 32 + 31 - Math.clz32(low));
        bits ^= low;
      }
    }
    return this.sortTopo(out);
  }

  /** Every commit reachable from `sha` (inclusive), oldest first. */
  reachable(sha: string): string[] {
    const R = this.reach(this.idx(sha));
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) if (has(R, i)) out.push(i);
    return this.sortTopo(out);
  }

  /** Sort SHAs so parents come before children (ties by commit time, then SHA). */
  sortTopological(shas: readonly string[]): string[] {
    return this.sortTopo(shas.map((s) => this.idx(s)));
  }

  /** Same set as `git merge-base --all a b`, newest first (ties by SHA). */
  mergeBases(a: string, b: string): string[] {
    const A = this.reach(this.idx(a));
    const B = this.reach(this.idx(b));
    const common = new Uint32Array(this.words);
    for (let w = 0; w < this.words; w++) common[w] = A[w]! & B[w]!;
    // The common set is closed under "ancestor of", so a common commit is a best base exactly when none of
    // its children is common.
    const notBest = new Uint32Array(this.words);
    for (let i = 0; i < this.size; i++) {
      if (!has(common, i)) continue;
      for (const p of this.parentsOf(i)) set(notBest, p);
    }
    const best: number[] = [];
    for (let i = 0; i < this.size; i++) if (has(common, i) && !has(notBest, i)) best.push(i);
    best.sort((x, y) => this.times[y]! - this.times[x]! || cmp(this.shas[x]!, this.shas[y]!));
    return best.map((i) => this.shas[i]!);
  }

  /** One best common ancestor (the newest of `mergeBases`), or null for unrelated histories. */
  mergeBase(a: string, b: string): string | null {
    return this.mergeBases(a, b)[0] ?? null;
  }

  private idx(sha: string): number {
    const i = this.index.get(sha);
    if (i === undefined) throw new UnknownCommitError(sha);
    return i;
  }

  private parentsOf(i: number): Int32Array {
    return this.parentList.subarray(this.parentStart[i]!, this.parentStart[i + 1]!);
  }

  private reach(i: number): Bits {
    let seen = this.reachCache.get(i);
    if (seen) return seen;
    seen = new Uint32Array(this.words);
    const stack = [i];
    while (stack.length) {
      const x = stack.pop()!;
      if (has(seen, x)) continue;
      // A cached ancestor's set can be merged in whole instead of walked again.
      const cached = x !== i ? this.reachCache.get(x) : undefined;
      if (cached) {
        for (let w = 0; w < this.words; w++) seen[w]! |= cached[w]!;
        continue;
      }
      set(seen, x);
      for (const p of this.parentsOf(x)) if (!has(seen, p)) stack.push(p);
    }
    this.reachCache.set(i, seen);
    return seen;
  }

  /** Parents before children; otherwise by commit time, then SHA. */
  private sortTopo(ids: number[]): string[] {
    const rank = this.ranks();
    ids.sort((x, y) => rank[x]! - rank[y]!);
    return ids.map((i) => this.shas[i]!);
  }

  private ranks(): Int32Array {
    if (this.topoRank) return this.topoRank;
    const n = this.size;
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (x, y) => this.times[x]! - this.times[y]! || cmp(this.shas[x]!, this.shas[y]!),
    );
    const rank = new Int32Array(n).fill(-1);
    let next = 0;
    // Iterative post-order DFS: a commit gets its rank after all its parents.
    const stack: number[] = [];
    const expanded = new Uint8Array(n);
    for (const root of order) {
      if (rank[root] !== -1) continue;
      stack.push(root);
      while (stack.length) {
        const x = stack[stack.length - 1]!;
        if (rank[x] !== -1) {
          stack.pop();
          continue;
        }
        if (expanded[x]) {
          rank[x] = next++;
          stack.pop();
          continue;
        }
        expanded[x] = 1;
        const ps = Array.from(this.parentsOf(x)).filter((p) => rank[p] === -1);
        ps.sort((p, q) => this.times[q]! - this.times[p]! || cmp(this.shas[q]!, this.shas[p]!));
        stack.push(...ps);
      }
    }
    this.topoRank = rank;
    return rank;
  }
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
