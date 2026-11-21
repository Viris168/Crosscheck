# @app/git-graph

Branch tree engine (lane T). Spec: `tasks/T-branch-tree.md`; behavior ported from
`docs/branch-tree/prototype.html` (`reach`, `aheadBehind`, `equivalence`, `contentMerged`, `prMerge`,
`closest`, `inferBase`, `chooseBase`, `compareMap`, `branchOrder`).

| Entry | Runtime | What |
|---|---|---|
| `@app/git-graph` | any (pure) | `CommitGraph` (ahead/behind, merge bases, ancestry), `pickCompareWith`, `buildSnapshot`, `prMerge`, `detectMerged`, `needsContentCheck`, `matchPatchIds`, `contentMerged`, `mergedByContent`, `whyShort`/`whyLong` |
| `@app/git-graph/git` | Node | `runGit` (no shell, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, scrubbed errors), `readCommitGraph`, `patchIds`, `mergeTreeId`, `treeId`, `withContentWorkspace`, `detectMergedWithFallbacks`, `assertNoContents` |
| `@app/git-graph/testing` | Node, tests only | `FixtureRepo` builder, `commitsOnlyClone`, and the fixture repos with expected compare-with picks and merged states |

Privacy: the adapter only parses SHAs, parent SHAs and commit times (`%H %P %ct`). `patchIds`,
`mergeTreeId` and `treeId` need trees/blobs and are meant for the throwaway workspace, never the
commits-only cache clone.

Merged state (T3a): `detectMergedWithFallbacks(cacheGitDir, auth, input)` applies the PR record on the graph,
then runs the content check for the remaining branches in **one** `withContentWorkspace`: a temp
`git clone --bare --shared` of the cache that is a promisor clone of the real remote, so trees/blobs are
fetched into the temp dir only. The dir is removed in `finally` (and swept by prefix if a process died);
on timeout the whole git process group is killed. Pass its `content` to `buildSnapshot({ content })`.

Tests: `pnpm turbo test --filter @app/git-graph`. `test/oracle.test.ts` compares the engine with
`git rev-list --count`, `git merge-base [--all|--is-ancestor]`, `git cherry` and a real merge
(for `merge-tree`) on every branch pair of every fixture; it is skipped with a message on git < 2.38.
