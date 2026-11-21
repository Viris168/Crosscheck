// Commit graph over SHAs, parents and commit times only (prototype: `reach`, `aheadBehind`).
// SHAs are indexed to ints; parents live in one Int32Array (CSR layout). Every walk is an explicit
// stack/heap loop, never recursion, so deep histories cannot overflow the call stack.
//
// Two ways to answer a pair query (T6a):
// - a **two-colour walk** from both commits, newest generation first, that stops at the merge-base
//   frontier (git's `paint_down_to_common`). It only touches the commits that differ plus the frontier,
//   so it is cheap for the usual "branch a few commits off main" case.
// - **reach bitsets** (one bit per commit, cached per commit, prototype `reachCache`). A pair query on two
//   cached sets is a few thousand word operations. The walk falls back to bitsets when it gets long
//   (old or unrelated branches), so the sets of branch heads end up cached and reused.
// Generation numbers (1 + max parent generation) order the walk exactly (a parent always has a lower
// generation than its child) and prune ancestry checks.

export interface CommitInput {
  sha: string;
  parents: readonly string[];
  /** ISO 8601 (or anything `Date.parse` accepts) */
  committedAt: string;
}

/** Ahead/behind and the newest best merge base of a pair (GET /tree/compare). */
export interface CompareResult {
  /** `git rev-list --count b..a` */
  ahead: number;
  /** `git rev-list --count a..b` */
  behind: number;
  /** newest of `git merge-base --all a b`, null for unrelated histories */
  mergeBase: string | null;
}

/** @internal Pre-indexed graph (from `parseGraph`); not part of the public API. */
export interface GraphParts {
  shas: string[];
  parentStart: Int32Array;
  parentList: Int32Array;
  /** ms since epoch */
  times: Float64Array;
  hasMissingParents: boolean;
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

// Two-colour walk flags.
const A = 1;
const B = 2;
const BOTH = 3;
const STALE = 4;

/** Cached reach sets kept per graph (oldest dropped first). 4096 × 50k commits ≈ 25 MB. */
const MAX_CACHED_SETS = 4096;

export class CommitGraph {
  readonly size: number;
  /** true when some parent SHA was not in the input (shallow or truncated history) */
  readonly hasMissingParents: boolean;
  private readonly shas: string[];
  /** as given to the constructor; null when built from parts (then derived from `times`) */
  private readonly committedAtIn: string[] | null;
  private readonly index = new Map<string, number>();
  private readonly parentStart: Int32Array;
  private readonly parentList: Int32Array;
  private readonly times: Float64Array;
  private readonly words: number;
  /** a two-colour walk longer than this falls back to bitsets */
  private readonly walkBudget: number;
  // Commits never change, so what a commit reaches can be cached for good (prototype `reachCache`).
  private readonly reachCache = new Map<number, Bits>();
  private readonly reachCounts = new Map<number, number>();
  private topoRank: Int32Array | null = null;
  private gen: Int32Array | null = null;
  private childIndex: { childStart: Int32Array; childList: Int32Array } | null = null;
  // Scratch buffers for the walks (allocated once; every walk is synchronous).
  private flagBuf: Uint8Array | null = null;
  private heapBuf: Int32Array | null = null;
  private touchBuf: Int32Array | null = null;
  private stampBuf: Uint32Array | null = null;
  private stamp = 0;
  /** isAncestor: the last b asked about, and how many commits its walks visited so far */
  private ancestorOf = -1;
  private ancestorSpent = 0;

  /** `parts` is internal (used by `parseGraph`); pass commits only. */
  constructor(commits: readonly CommitInput[], parts?: GraphParts) {
    if (parts) {
      this.shas = parts.shas;
      this.committedAtIn = null;
      this.parentStart = parts.parentStart;
      this.parentList = parts.parentList;
      this.times = parts.times;
      this.hasMissingParents = parts.hasMissingParents;
      this.size = parts.shas.length;
      for (let i = 0; i < this.size; i++) this.index.set(parts.shas[i]!, i);
      if (this.index.size !== this.size) throw new Error('duplicate commit');
    } else {
      const unique: CommitInput[] = [];
      this.shas = [];
      this.committedAtIn = [];
      for (const c of commits) {
        if (this.index.has(c.sha)) continue;
        this.index.set(c.sha, unique.length);
        this.shas.push(c.sha);
        this.committedAtIn.push(c.committedAt);
        unique.push(c);
      }
      const n = unique.length;
      this.size = n;
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
    this.words = Math.ceil(this.size / 32) || 1;
    this.walkBudget = Math.max(1024, this.size >>> 3);
  }

  has(sha: string): boolean {
    return this.index.has(sha);
  }

  commit(sha: string): { sha: string; parents: string[]; committedAt: string } {
    const i = this.idx(sha);
    return {
      sha,
      parents: Array.from(this.parentsOf(i), (p) => this.shas[p]!),
      committedAt: this.committedAtOf(i),
    };
  }

  /** Commit time in ms since epoch (0 when it could not be parsed). */
  timeOf(sha: string): number {
    return this.times[this.idx(sha)]!;
  }

  isMerge(sha: string): boolean {
    const i = this.idx(sha);
    return this.parentStart[i + 1]! - this.parentStart[i]! > 1;
  }

  /** Is `a` an ancestor of `b` (or equal)? Same as `git merge-base --is-ancestor a b`. */
  isAncestor(a: string, b: string): boolean {
    const ai = this.idx(a);
    const bi = this.idx(b);
    if (ai === bi) return true;
    const cached = this.reachCache.get(bi);
    if (cached) return has(cached, ai);
    const gen = this.generations();
    // An ancestor always has a lower generation.
    if (gen[ai]! >= gen[bi]!) return false;
    // Walk down from b, never below a's generation. Long walks build b's reach set instead, so the
    // next question about b (inferBase asks about every branch) is one bit test.
    const floor = gen[ai]!;
    const stamps = this.stamps();
    const mark = ++this.stamp;
    const stack = [bi];
    stamps[bi] = mark;
    // Effort adds up over consecutive questions about the same b.
    if (this.ancestorOf !== bi) {
      this.ancestorOf = bi;
      this.ancestorSpent = 0;
    }
    while (stack.length) {
      const x = stack.pop()!;
      if (x === ai) return true;
      if (++this.ancestorSpent > this.walkBudget) return has(this.reach(bi), ai);
      for (const p of this.parentsOf(x)) {
        if (stamps[p] === mark || gen[p]! < floor) continue;
        stamps[p] = mark;
        stack.push(p);
      }
    }
    return false;
  }

  /** ahead = `git rev-list --count b..a`, behind = `git rev-list --count a..b`. */
  aheadBehind(a: string, b: string): { ahead: number; behind: number } {
    const ai = this.idx(a);
    const bi = this.idx(b);
    if (ai === bi) return { ahead: 0, behind: 0 };
    if (this.walkFirst(ai, bi)) {
      const r = this.paint(ai, bi, false, null);
      if (r) return { ahead: r.ahead, behind: r.behind };
    }
    const A_ = this.reach(ai);
    const B_ = this.reach(bi);
    // One inside the other: the difference of the two set sizes, no scan.
    if (has(B_, ai)) return { ahead: 0, behind: this.reachCount(bi) - this.reachCount(ai) };
    if (has(A_, bi)) return { ahead: this.reachCount(ai) - this.reachCount(bi), behind: 0 };
    let ahead = 0;
    let behind = 0;
    for (let w = 0; w < this.words; w++) {
      ahead += popcount(A_[w]! & ~B_[w]!);
      behind += popcount(B_[w]! & ~A_[w]!);
    }
    return { ahead, behind };
  }

  /** Ahead, behind and the newest best merge base in one walk (GET /tree/compare). */
  compare(a: string, b: string): CompareResult {
    const ai = this.idx(a);
    const bi = this.idx(b);
    if (ai === bi) return { ahead: 0, behind: 0, mergeBase: a };
    if (this.walkFirst(ai, bi)) {
      const r = this.paint(ai, bi, true, null);
      if (r)
        return { ahead: r.ahead, behind: r.behind, mergeBase: this.newest(r.bases)[0] ?? null };
    }
    return { ...this.aheadBehind(a, b), mergeBase: this.mergeBase(a, b) };
  }

  /** Commits in `b..a` (reachable from a, not from b), oldest first (parents before children). */
  aheadCommits(a: string, b: string): string[] {
    const ai = this.idx(a);
    const bi = this.idx(b);
    if (ai === bi) return [];
    const out: number[] = [];
    if (this.walkFirst(ai, bi) && this.paint(ai, bi, false, out)) return this.sortTopo(out);
    out.length = 0;
    const A_ = this.reach(ai);
    const B_ = this.reach(bi);
    for (let w = 0; w < this.words; w++) {
      let bits = A_[w]! & ~B_[w]!;
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

  /**
   * The newest `limit` commits reachable from `sha`, oldest first. Same as `reachable(sha).slice(-limit)`
   * without sorting the whole history.
   */
  reachableTail(sha: string, limit: number): string[] {
    if (limit <= 0) return [];
    const R = this.reach(this.idx(sha));
    const order = this.topoOrder();
    const out: string[] = [];
    for (let r = this.size - 1; r >= 0 && out.length < limit; r--) {
      const i = order[r]!;
      if (has(R, i)) out.push(this.shas[i]!);
    }
    return out.reverse();
  }

  /** Sort SHAs so parents come before children (ties by commit time, then SHA). */
  sortTopological(shas: readonly string[]): string[] {
    return this.sortTopo(shas.map((s) => this.idx(s)));
  }

  /** Same set as `git merge-base --all a b`, newest first (ties by SHA). */
  mergeBases(a: string, b: string): string[] {
    const ai = this.idx(a);
    const bi = this.idx(b);
    if (ai === bi) return [a];
    if (this.walkFirst(ai, bi)) {
      const r = this.paint(ai, bi, true, null);
      if (r) return this.newest(r.bases);
    }
    const A_ = this.reach(ai);
    const B_ = this.reach(bi);
    if (has(B_, ai)) return [a];
    if (has(A_, bi)) return [b];
    // The common set is closed under "ancestor of", so a common commit is a best base exactly when none of
    // its children is common. Such a commit (not a or b, handled above) has a child on a path from a or b,
    // and that child is on one side only: so the candidates are the common parents of one-sided commits.
    const common = (i: number) => has(A_, i) && has(B_, i);
    const { childStart, childList } = this.children();
    const seen = new Set<number>();
    const best: number[] = [];
    for (let w = 0; w < this.words; w++) {
      let bits = A_[w]! ^ B_[w]!;
      while (bits) {
        const low = bits & -bits;
        bits ^= low;
        const x = w * 32 + 31 - Math.clz32(low);
        for (const p of this.parentsOf(x)) {
          if (seen.has(p) || !common(p)) continue;
          seen.add(p);
          let isBest = true;
          for (let c = childStart[p]!; c < childStart[p + 1]!; c++)
            if (common(childList[c]!)) {
              isBest = false;
              break;
            }
          if (isBest) best.push(p);
        }
      }
    }
    return this.newest(best);
  }

  /** One best common ancestor (the newest of `mergeBases`), or null for unrelated histories. */
  mergeBase(a: string, b: string): string | null {
    return this.mergeBases(a, b)[0] ?? null;
  }

  /** @internal Raw arrays for `serializeGraph`. Do not mutate. */
  parts(): GraphParts {
    return {
      shas: this.shas,
      parentStart: this.parentStart,
      parentList: this.parentList,
      times: this.times,
      hasMissingParents: this.hasMissingParents,
    };
  }

  private idx(sha: string): number {
    const i = this.index.get(sha);
    if (i === undefined) throw new UnknownCommitError(sha);
    return i;
  }

  private committedAtOf(i: number): string {
    return this.committedAtIn ? this.committedAtIn[i]! : new Date(this.times[i]!).toISOString();
  }

  private parentsOf(i: number): Int32Array {
    return this.parentList.subarray(this.parentStart[i]!, this.parentStart[i + 1]!);
  }

  /**
   * Try the two-colour walk first? Not when both reach sets are cached (a word scan is cheaper), and not
   * when the generation gap alone is over the walk budget: every commit above the lower one's generation is
   * on one side only, so the walk would take at least that many and then give up.
   */
  private walkFirst(a: number, b: number): boolean {
    if (this.reachCache.has(a) && this.reachCache.has(b)) return false;
    const gen = this.generations();
    return Math.abs(gen[a]! - gen[b]!) <= this.walkBudget;
  }

  /** |reach(i)|, cached with the set. */
  private reachCount(i: number): number {
    let c = this.reachCounts.get(i);
    if (c === undefined) {
      const R = this.reach(i);
      c = 0;
      for (let w = 0; w < this.words; w++) c += popcount(R[w]!);
      this.reachCounts.set(i, c);
    }
    return c;
  }

  /** Newest first, ties by SHA. */
  private newest(ids: number[]): string[] {
    ids.sort((x, y) => this.times[y]! - this.times[x]! || cmp(this.shas[x]!, this.shas[y]!));
    return ids.map((i) => this.shas[i]!);
  }

  /**
   * Two-colour walk (git `paint_down_to_common`). Commits are taken highest generation first, so a commit's
   * colours are final when it is taken (every child that reaches it was taken before). Colour A = reachable
   * from a, B = from b. A-only commits are `ahead`, B-only `behind`. With `wantBases`, a commit that is
   * both colours and not STALE is a best merge base; its parents get STALE. The walk stops when every
   * queued commit is both colours (or STALE with `wantBases`): what lies below is common to both.
   * Returns null when the walk goes over `walkBudget` (the caller falls back to bitsets).
   */
  private paint(
    a: number,
    b: number,
    wantBases: boolean,
    aheadOut: number[] | null,
  ): { ahead: number; behind: number; bases: number[] } | null {
    const n = this.size;
    const gen = this.generations();
    const flags = (this.flagBuf ??= new Uint8Array(n));
    const heap = (this.heapBuf ??= new Int32Array(n));
    const touched = (this.touchBuf ??= new Int32Array(n));
    const done = wantBases ? (f: number) => (f & STALE) !== 0 : (f: number) => (f & BOTH) === BOTH;
    let hn = 0;
    let tn = 0;
    let active = 0; // queued commits that are not done yet
    let taken = 0;
    let ahead = 0;
    let behind = 0;
    const bases: number[] = [];

    // Max-heap on generation (ties by index: any order is valid between equal generations).
    const above = (x: number, y: number) => gen[x]! > gen[y]! || (gen[x] === gen[y] && x > y);
    const push = (x: number) => {
      let i = hn++;
      while (i > 0) {
        const up = (i - 1) >> 1;
        const y = heap[up]!;
        if (!above(x, y)) break;
        heap[i] = y;
        i = up;
      }
      heap[i] = x;
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap[--hn]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= hn) break;
        const r = l + 1;
        const c = r < hn && above(heap[r]!, heap[l]!) ? r : l;
        if (!above(heap[c]!, last)) break;
        heap[i] = heap[c]!;
        i = c;
      }
      if (hn > 0) heap[i] = last;
      return top;
    };
    const paintOne = (x: number, add: number) => {
      const before = flags[x]!;
      const after = before | add;
      if (after === before) return;
      flags[x] = after;
      if (before === 0) {
        touched[tn++] = x;
        push(x);
        if (!done(after)) active++;
      } else if (!done(before) && done(after)) active--;
    };

    paintOne(a, A);
    paintOne(b, B);
    let ok = true;
    while (active > 0) {
      if (++taken > this.walkBudget) {
        ok = false;
        break;
      }
      const x = pop();
      let f = flags[x]!;
      if (!done(f)) active--;
      const colour = f & BOTH;
      if (colour === A) {
        ahead++;
        aheadOut?.push(x);
      } else if (colour === B) behind++;
      else if (wantBases && !(f & STALE)) {
        bases.push(x);
        f |= STALE;
      }
      if (wantBases && colour === BOTH) f |= STALE;
      for (const p of this.parentsOf(x)) paintOne(p, f);
    }
    for (let i = 0; i < tn; i++) flags[touched[i]!] = 0;
    return ok ? { ahead, behind, bases } : null;
  }

  /** Children in CSR layout (the inverse of the parent lists), built on first use. */
  private children(): { childStart: Int32Array; childList: Int32Array } {
    if (this.childIndex) return this.childIndex;
    const n = this.size;
    const childStart = new Int32Array(n + 1);
    for (let i = 0; i < this.parentList.length; i++) childStart[this.parentList[i]! + 1]!++;
    for (let i = 0; i < n; i++) childStart[i + 1]! += childStart[i]!;
    const fill = childStart.slice(0, n);
    const childList = new Int32Array(this.parentList.length);
    for (let x = 0; x < n; x++) for (const p of this.parentsOf(x)) childList[fill[p]!++] = x;
    this.childIndex = { childStart, childList };
    return this.childIndex;
  }

  private stamps(): Uint32Array {
    if (!this.stampBuf || this.stamp >= 0xfffffff0) {
      this.stampBuf = new Uint32Array(this.size);
      this.stamp = 0;
    }
    return this.stampBuf;
  }

  /** gen = 1 + max(parent gens); roots (and commits whose parents are missing) are 1. */
  private generations(): Int32Array {
    if (this.gen) return this.gen;
    const n = this.size;
    const gen = new Int32Array(n);
    const expanded = new Uint8Array(n);
    const stack: number[] = [];
    for (let root = 0; root < n; root++) {
      if (gen[root]) continue;
      stack.push(root);
      while (stack.length) {
        const x = stack[stack.length - 1]!;
        if (gen[x]) {
          stack.pop();
          continue;
        }
        const ps = this.parentsOf(x);
        if (expanded[x]) {
          let g = 0;
          for (const p of ps) if (gen[p]! > g) g = gen[p]!;
          gen[x] = g + 1;
          stack.pop();
          continue;
        }
        expanded[x] = 1;
        for (const p of ps) if (!gen[p] && !expanded[p]) stack.push(p);
      }
    }
    this.gen = gen;
    return gen;
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
    if (this.reachCache.size >= MAX_CACHED_SETS) {
      const oldest = this.reachCache.keys().next().value!;
      this.reachCache.delete(oldest);
      this.reachCounts.delete(oldest);
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

  /** commit index by rank (inverse of `ranks`) */
  private topoOrder(): Int32Array {
    const rank = this.ranks();
    const order = new Int32Array(this.size);
    for (let i = 0; i < this.size; i++) order[rank[i]!] = i;
    return order;
  }

  private ranks(): Int32Array {
    if (this.topoRank) return this.topoRank;
    const n = this.size;
    const byTime = (x: number, y: number) =>
      this.times[x]! - this.times[y]! || cmp(this.shas[x]!, this.shas[y]!);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort(byTime);
    const rank = new Int32Array(n).fill(-1);
    let next = 0;
    // Iterative post-order DFS: a commit gets its rank after all its parents.
    const stack: number[] = [];
    const expanded = new Uint8Array(n);
    const ps: number[] = [];
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
        ps.length = 0;
        for (const p of this.parentsOf(x)) if (rank[p] === -1) ps.push(p);
        if (ps.length > 1) ps.sort((p, q) => byTime(q, p));
        for (const p of ps) stack.push(p);
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

/** `{ ahead, behind, mergeBase }` of `a` vs `b` (SHAs), for GET /tree/compare. */
export function compare(graph: CommitGraph, a: string, b: string): CompareResult {
  return graph.compare(a, b);
}
