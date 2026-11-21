// Which branch each branch is compared with. Port of the prototype's `closest`, `inferBase`,
// `chooseBase` and `compareMap`; rules in tasks/T-branch-tree.md → "Compare-with rules".
// Pure: overrides, PRs and recorded parents are inputs; nothing is fetched here.
import type { CommitGraph } from './graph';
import type { CompareWhy, MergeMethod, PullRequestState } from '../types';

export const LONG_LIVED = /^(main|master|dev|develop|staging|release\/.+)$/;

export interface BranchInput {
  name: string;
  headSha: string;
  /** `Branch.recordedParents`: branches whose head was this branch's first commit when it was created */
  recordedParents?: readonly string[];
}

export interface PrRecord {
  number: number;
  /** head.ref (the branch) */
  headRef: string;
  /** base.ref (the target) */
  baseRef: string;
  state: PullRequestState;
  /** the PR's head SHA (at merge time for merged PRs) */
  headSha?: string | null;
  mergeMethod?: MergeMethod | null;
  /** GitHub `merge_commit_sha` (merged PRs): the merge commit, the squash commit or the last rebased one */
  mergeCommitSha?: string | null;
}

export type Lookup = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface CompareInput {
  graph: CommitGraph;
  defaultBranch: string;
  branches: readonly BranchInput[];
  /** `CompareOverride` rows: branch → compareWith */
  overrides?: Lookup;
  prs?: readonly PrRecord[];
}

export interface CompareChoice {
  compareWith: string | null;
  why: CompareWhy;
  whyPr: number | null;
  ambiguous: number | null;
  loop: boolean;
}

const choice = (
  compareWith: string | null,
  why: CompareWhy,
  extra: Partial<CompareChoice> = {},
): CompareChoice => ({
  compareWith,
  why,
  whyPr: null,
  ambiguous: null,
  loop: false,
  ...extra,
});

function toMap(l: Lookup | undefined): Map<string, string> {
  if (!l) return new Map();
  if (l instanceof Map) return new Map(l);
  return new Map(Object.entries(l));
}

/** Prototype `better`: lexicographic `<` on score tuples. */
function better(a: readonly (number | string)[], b: readonly (number | string)[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

class Repo {
  readonly heads = new Map<string, string>();
  readonly recorded = new Map<string, readonly string[]>();
  readonly overrides: Map<string, string>;
  /** sorted by number; the last is the newest */
  readonly prs: PrRecord[];

  constructor(readonly input: CompareInput) {
    for (const b of input.branches) {
      if (!input.graph.has(b.headSha))
        throw new Error(`Head of branch "${b.name}" (${b.headSha}) is not in the graph`);
      this.heads.set(b.name, b.headSha);
      if (b.recordedParents) this.recorded.set(b.name, b.recordedParents);
    }
    if (input.branches.length && !this.heads.has(input.defaultBranch)) {
      throw new Error(`Default branch "${input.defaultBranch}" is not in the branch list`);
    }
    this.overrides = toMap(input.overrides);
    this.prs = [...(input.prs ?? [])].sort((a, b) => a.number - b.number);
  }

  get def() {
    return this.input.defaultBranch;
  }

  isLongLived(b: string) {
    return b === this.def || LONG_LIVED.test(b);
  }

  head(b: string) {
    return this.heads.get(b)!;
  }

  /** Prototype `closest`: lowest [ahead, default?0:1, longLived?0:1, behind, name]. */
  closest(b: string, candidates: readonly string[]): string | null {
    let best: { x: string; score: (number | string)[] } | null = null;
    for (const x of candidates) {
      const { ahead, behind } = this.input.graph.aheadBehind(this.head(b), this.head(x));
      const score = [ahead, x === this.def ? 0 : 1, this.isLongLived(x) ? 0 : 1, behind, x];
      if (!best || better(score, best.score)) best = { x, score };
    }
    return best ? best.x : null;
  }

  /** Prototype `inferBase`: long-lived branches, or branches whose (different) head this branch contains. */
  inferBase(b: string): string | null {
    const head = this.head(b);
    const g = this.input.graph;
    const cands = [...this.heads.keys()].filter(
      (x) =>
        x !== b &&
        (this.isLongLived(x) || (this.head(x) !== head && g.isAncestor(this.head(x), head))),
    );
    return this.closest(b, cands);
  }

  /** Prototype `chooseBase`: override > PR target > recorded > inferred > default. */
  chooseBase(b: string): CompareChoice {
    const live = (x: string | undefined): x is string => x != null && this.heads.has(x) && x !== b;
    const override = this.overrides.get(b);
    if (live(override)) return choice(override, 'override');
    const prs = this.prs.filter((p) => p.headRef === b && live(p.baseRef));
    const pr =
      prs.filter((p) => p.state === 'open').pop() ?? prs.filter((p) => p.state === 'merged').pop();
    if (pr) return choice(pr.baseRef, 'pr', { whyPr: pr.number });
    const rec = (this.recorded.get(b) ?? []).filter(live);
    if (rec.length === 1) return choice(rec[0]!, 'recorded');
    if (rec.length > 1) return choice(this.closest(b, rec), 'recorded', { ambiguous: rec.length });
    const guess = this.inferBase(b);
    if (guess) return choice(guess, 'inferred');
    return choice(this.def, 'default');
  }
}

/** Prototype `compareMap`: a choice for every branch, with loops broken by falling back to the default. */
export function pickCompareWith(input: CompareInput): Map<string, CompareChoice> {
  const r = new Repo(input);
  const m = new Map<string, CompareChoice>();
  for (const b of r.heads.keys()) m.set(b, b === r.def ? choice(null, 'default') : r.chooseBase(b));
  // Guesses and hand-set choices can point at each other. Walk in name order; a later walk sees the
  // earlier fixes, exactly like the prototype.
  for (const b of [...m.keys()].sort()) {
    const seen = new Set([b]);
    let x = m.get(b)!.compareWith;
    while (x && !seen.has(x)) {
      seen.add(x);
      x = m.get(x)!.compareWith;
    }
    if (x === b) m.set(b, choice(r.def, 'default', { loop: true }));
  }
  return m;
}

/** Prototype `branchOrder`: default branch, then a depth-first walk of compare-with children by name. */
export function branchOrder(
  defaultBranch: string,
  choices: ReadonlyMap<string, CompareChoice>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const children = new Map<string, string[]>();
  for (const [b, c] of choices) {
    if (!c.compareWith) continue;
    const list = children.get(c.compareWith) ?? [];
    list.push(b);
    children.set(c.compareWith, list);
  }
  for (const list of children.values()) list.sort();
  const stack = choices.has(defaultBranch) ? [defaultBranch] : [];
  while (stack.length) {
    const b = stack.pop()!;
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
    const kids = children.get(b) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  for (const b of choices.keys()) if (!seen.has(b)) out.push(b);
  return out;
}

/** Prototype `whyShort`: the label in each row's sub-line. */
export function whyShort(c: Pick<CompareChoice, 'why' | 'whyPr' | 'ambiguous'>): string {
  switch (c.why) {
    case 'override':
      return 'set by hand';
    case 'pr':
      return `PR #${c.whyPr}`;
    case 'recorded':
      return c.ambiguous ? 'ambiguous' : 'recorded';
    case 'inferred':
      return 'guess';
    default:
      return 'default';
  }
}

/** Prototype `whyLong`: the sentence in the branch details panel. */
export function whyLong(c: CompareChoice, prState?: PullRequestState): string {
  switch (c.why) {
    case 'override':
      return 'Set by hand below.';
    case 'pr':
      return `Target of PR #${c.whyPr}${prState ? ` (${prState})` : ''}.`;
    case 'recorded':
      return c.ambiguous
        ? `Recorded when the branch appeared, but ${c.ambiguous} branches were at that commit, so this is the closest of them.`
        : 'Recorded when the branch appeared: it was the only branch at that commit.';
    case 'inferred':
      return 'Guessed from the commit graph: the long-lived branch, or a branch this one fully contains, that it is fewest commits beyond.';
    default:
      return c.loop
        ? 'The choices formed a loop, so the default branch.'
        : 'Nothing better known, so the default branch.';
  }
}
