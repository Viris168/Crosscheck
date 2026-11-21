// Port of the prototype's `equivalence` + `contentMerged`, mapped onto what real git can tell us:
//   'patch'   another commit in the target has the same patch id   (`git cherry` "-" lines)
//   'content' its change is already in the target                  (`git merge-tree` gives T's own tree)
//   'merge'   a merge commit, which adds no change of its own
//   'new'     not in the target
// Inputs are ids only (patch ids, tree ids); this module never sees file contents.

export interface CherryLine {
  sha: string;
  /** true = "-" (an equivalent patch is in the target), false = "+" */
  equivalent: boolean;
  /** the target commit with the same patch id */
  twin: string | null;
}

/**
 * Same result as `git cherry <target> <branch>`: one line per branch-only commit that has a patch id
 * (merges have none and are skipped, like git cherry does), in the order of `branchOnly`.
 */
export function matchPatchIds(
  branchOnly: ReadonlyMap<string, string>,
  targetOnly: ReadonlyMap<string, string>,
): CherryLine[] {
  const byPatch = new Map<string, string>();
  for (const [sha, patchId] of targetOnly) if (!byPatch.has(patchId)) byPatch.set(patchId, sha);
  return [...branchOnly].map(([sha, patchId]) => {
    const twin = byPatch.get(patchId) ?? null;
    return { sha, equivalent: twin !== null, twin };
  });
}

/**
 * Is the branch's change already in the target? `mergeTreeId` is the tree of
 * `git merge-tree --write-tree T B` (null when it conflicted); `targetTreeId` is `T^{tree}`.
 */
export function contentMerged(mergeTreeId: string | null, targetTreeId: string): boolean {
  return mergeTreeId !== null && mergeTreeId === targetTreeId;
}

export type EquivalenceKind = 'merge' | 'patch' | 'content' | 'new';

export interface EquivalenceInput {
  /** commits in T..B (oldest first) */
  ahead: readonly string[];
  isMerge: (sha: string) => boolean;
  /** branch commits whose patch id matches a commit in T (`git cherry` "-" lines) */
  patchMatched: ReadonlySet<string> | readonly string[];
  /** `contentMerged(...)` for the whole branch; checked once, not per commit */
  contentInTarget: boolean;
}

/** Prototype `equivalence`: classify each ahead commit. */
export function equivalence(input: EquivalenceInput): { sha: string; kind: EquivalenceKind }[] {
  const matched =
    input.patchMatched instanceof Set ? input.patchMatched : new Set(input.patchMatched);
  return input.ahead.map((sha) => {
    if (input.isMerge(sha)) return { sha, kind: 'merge' };
    if (matched.has(sha)) return { sha, kind: 'patch' };
    return { sha, kind: input.contentInTarget ? 'content' : 'new' };
  });
}

/** Prototype `contentMerged`: 'rebased', 'squashed' or null. Nothing ahead → null (the row shows ↑0). */
export function mergedByContent(input: EquivalenceInput): 'rebased' | 'squashed' | null {
  const eq = equivalence(input);
  if (!eq.length || eq.some((e) => e.kind === 'new')) return null;
  return eq.every((e) => e.kind !== 'content') ? 'rebased' : 'squashed';
}
