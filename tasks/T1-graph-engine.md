# T1 — Graph engine library (milestone 1)

**Wave 1** · **Branch:** `feat/t1-graph-engine` · **Lane:** T (new) · **Needs merged:** nothing
**Spec:** `tasks/T-branch-tree.md` → "Compare-with rules", "Merged-state rules", "Privacy rules".
**Reference:** the prototype (`docs/branch-tree/prototype.html`). Port its logic; don't redesign it.

## You own (edit only these)
- `packages/git-graph/**` (new package `@app/git-graph`)
- `tasks/T-branch-tree.md` → only the "Compare-with rules" section, and only in your first commit, if the
  prototype's rule order differs. Say what changed in the PR description.

## Do
1. **Package** `@app/git-graph` like `packages/scoring` (ESM, `src/index.ts`, vitest, eslint, tsconfig).
   No dependency on `@app/db`, Next.js or Octokit. Contracts come from T0; until it merges, copy the types
   into `src/types.ts` with a `// TODO(T0): import from @app/shared` and swap them in your last commit if T0
   is merged by then.
2. **Pure core** `src/core/` (no I/O):
   - `CommitGraph` built from `{ sha, parents, committedAt }[]`. Index SHAs to ints; parents as `Int32Array`.
   - `isAncestor(a, b)`, `mergeBase(a, b)`, `aheadBehind(a, b) → { ahead, behind }`
     (ahead = `rev-list --count b..a`). Bounded walks; no recursion (deep histories).
   - `matchPatchIds(branchOnly: Map<sha, patchId>, targetOnly: Map<sha, patchId>)` → `git cherry` result.
   - `contentMerged(mergeTreeId, targetTreeId)` → boolean.
   - `pickCompareWith(input)` → `{ compareWith, why }` for every branch, per the rules (overrides, PRs and
     recorded parents are inputs; the engine never fetches them).
   - `buildSnapshot(input)` → `TreeSnapshot` (`merged` left `null` except rule 1 `pr` and rule 2 `ancestor`,
     which need no contents; T3a adds 3–4).
3. **Git adapter** `src/git/` (Node only, exported from `@app/git-graph/git`, not the root entry):
   - `runGit(args, { cwd, env, timeoutMs })` via `execFile` (no shell). Always sets `GIT_TERMINAL_PROMPT=0`,
     `GIT_NO_LAZY_FETCH=1`. Scrubs `extraheader`/`x-access-token` from errors.
   - `readCommitGraph(gitDir, refs)` → parses `git rev-list --parents --format=%ct ... ` (or `log
     --format=%H %P %ct`). Never reads `%s`/`%b`/`%ae`.
   - `patchIds(gitDir, range)` and `mergeTreeId(gitDir, a, b)` / `treeId(gitDir, sha)` for T3a.
4. **Test repos** `test/fixtures/build.sh` (or a TS builder) makes these with plain git in a temp dir:
   merge commit, squash merge, rebase merge, stacked branches (`main → a → b → c`), two branches on one
   commit, a criss-cross merge, a branch behind and ahead at once.
5. **Oracle tests** `test/oracle.test.ts`: for every pair of branches in every fixture, the engine equals
   `git rev-list --count`, `git merge-base`, `git merge-base --is-ancestor`, `git cherry` (with patch-ids
   from the adapter) and `git merge-tree --write-tree`. Plus unit tests for each compare-with rule and
   cycle prevention. CI has git; skip the oracle suite with a clear message if `git --version` < 2.38.

## Done when
`pnpm turbo test --filter @app/git-graph` passes, and the oracle suite covers every fixture above.

## Not yours
Cloning, tokens, DB, jobs, routes. Performance beyond "no recursion" (T6a).
