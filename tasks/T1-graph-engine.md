# T1 — Graph engine library (milestone 1)

**Wave 1** · **Branch:** `feat/t1-graph-engine` · **Lane:** T (new) · **Needs merged:** nothing
**Spec:** `tasks/T-branch-tree.md` → "Compare-with rules", "Merged-state rules", "Privacy rules".
**Reference:** the prototype (`docs/branch-tree/prototype.html`). Port its logic (`reach`, `aheadBehind`,
`equivalence`, `contentMerged`, `prMerge`, `closest`, `inferBase`, `chooseBase`, `compareMap`); don't redesign it.
Its seed repos (`seedWeb`, `seedApi`) become test fixtures with the same expected compare-with picks.

## You own (edit only these)
- `packages/git-graph/**` (new package `@app/git-graph`)
If the prototype and the T-spec disagree, follow the prototype and list the difference in the PR description.

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
   - `pickCompareWith(input)` → `{ compareWith, why, whyPr, ambiguous, loop }` for every branch, per the
     rules incl. `closest` scoring and loop breaking (overrides, PRs and recorded parents are inputs; the
     engine never fetches them).
   - `buildSnapshot(input)` → `TreeSnapshot`. `merged` is filled from the PR record (rule 1) only; T3a adds
     the content rule.
3. **Git adapter** `src/git/` (Node only, exported from `@app/git-graph/git`, not the root entry):
   - `runGit(args, { cwd, env, timeoutMs })` via `execFile` (no shell). Always sets `GIT_TERMINAL_PROMPT=0`,
     `GIT_NO_LAZY_FETCH=1`. Scrubs `extraheader`/`x-access-token` from errors.
   - `readCommitGraph(gitDir, refs)` → parses `git rev-list --parents --format=%ct ... ` (or `log
     --format=%H %P %ct`). Never reads `%s`/`%b`/`%ae`.
   - `patchIds(gitDir, range)` and `mergeTreeId(gitDir, a, b)` / `treeId(gitDir, sha)` for T3a.
4. **Test repos** `test/fixtures/build.sh` (or a TS builder) makes these with plain git in a temp dir:
   the prototype's `web-app` and `api-server` demos, plus merge commit, squash merge, rebase merge, stacked
   branches (`main → a → b → c`), two branches on one commit, a criss-cross merge, a branch behind and ahead
   at once, and a loop made by two overrides.
5. **Oracle tests** `test/oracle.test.ts`: for every pair of branches in every fixture, the engine equals
   `git rev-list --count`, `git merge-base`, `git merge-base --is-ancestor`, `git cherry` (with patch-ids
   from the adapter) and `git merge-tree --write-tree`. Plus unit tests for each compare-with rule and
   cycle prevention. CI has git; skip the oracle suite with a clear message if `git --version` < 2.38.

## Done when
`pnpm turbo test --filter @app/git-graph` passes, and the oracle suite covers every fixture above.

## Not yours
Cloning, tokens, DB, jobs, routes. Performance beyond "no recursion" (T6a).
