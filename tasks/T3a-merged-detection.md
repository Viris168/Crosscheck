# T3a — Merged-state detection in the engine (Lane T, milestone 3)

**Wave 3** · **Branch:** `feat/t3a-merged-detection` · **Lane:** T · **Needs merged:** T1
**Spec:** `tasks/T-branch-tree.md` → "Merged-state rules", "Privacy rules" (throwaway workspace).

## You own (edit only these)
- `packages/git-graph/**`

## Do
1. **Pure**: `detectMerged(input)` in `src/core/merged.ts` applies rules 1–4 in order. Rules 3–4 take their
   results as input (`patchIdMatch`, `contentMatch` per branch), so the core stays pure.
   `newCommits` for rule 1 when the branch moved past the PR head.
2. **Throwaway workspace** `src/git/workspace.ts`:
   ```ts
   withContentWorkspace(cacheGitDir, auth, fn: (ws) => Promise<T>, { timeoutMs }): Promise<T>
   ```
   - `mkdtemp` under `os.tmpdir()` (mode 0700) → `git clone --bare --shared <cacheGitDir> <tmp>` → set
     `remote.origin.url` to the GitHub URL, `promisor=true`, `partialclonefilter=blob:none` **in the temp
     repo only** → objects fetched on demand land in `<tmp>/objects` (VERIFY with a test).
   - `ws.patchIds(range)`, `ws.mergeTreeId(a, b)`, `ws.treeId(sha)`.
   - `finally`: `rm -rf <tmp>` even on timeout/throw; a process-exit hook cleans leftovers matching the
     prefix. No file contents are ever returned from `fn`: only ids and booleans.
3. `detectMergedWithFallbacks(cacheGitDir, auth, graphInput, { maxBranches: 50, perBranchTimeoutMs: 10_000 })`
   — runs rules 1–2 on the graph, then opens **one** workspace for all remaining branches.

## Tests
On T1's fixtures (file URL as the "remote"):
- merge commit / squash / rebase **with** a PR record → `pr`; the same **without** a PR → `ancestor` /
  `content` / `patch_id`. Branch moved after merge → `newCommits` right.
- Not merged branch → `null`. Partially cherry-picked branch → `null` (not all `-`).
- After `withContentWorkspace`: temp dir gone; cache repo still has zero trees/blobs (`assertNoContents`).
- Timeout kills git and still cleans up.

## Not yours
Calling it from the job (T3b).
