# @app/git-graph

Branch tree engine (lane T). Spec: `tasks/T-branch-tree.md`; behavior ported from
`docs/branch-tree/prototype.html` (`reach`, `aheadBehind`, `equivalence`, `contentMerged`, `prMerge`,
`closest`, `inferBase`, `chooseBase`, `compareMap`, `branchOrder`).

| Entry | Runtime | What |
|---|---|---|
| `@app/git-graph` | any (pure) | `CommitGraph` (ahead/behind, merge bases, ancestry), `pickCompareWith`, `buildSnapshot`, `matchPatchIds`, `contentMerged`, `mergedByContent`, `whyShort`/`whyLong` |
| `@app/git-graph/git` | Node | `runGit` (no shell, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, scrubbed errors), `readCommitGraph`, `patchIds`, `mergeTreeId`, `treeId` |
| `@app/git-graph/testing` | Node, tests only | `FixtureRepo` builder and the fixture repos with expected compare-with picks |

Privacy: the adapter only parses SHAs, parent SHAs and commit times (`%H %P %ct`). `patchIds`,
`mergeTreeId` and `treeId` need trees/blobs and are meant for the throwaway workspace (T3a), never the
commits-only cache clone.

Tests: `pnpm turbo test --filter @app/git-graph`. `test/oracle.test.ts` compares the engine with
`git rev-list --count`, `git merge-base [--all|--is-ancestor]`, `git cherry` and a real merge
(for `merge-tree`) on every branch pair of every fixture; it is skipped with a message on git < 2.38.
