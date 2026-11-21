# @app/git-graph

## Performance budget (T6a, milestone 6)

Written before optimizing. Target repo: **500 branches, 50 000 commits** (generated, `bench/generate.ts`),
on the **2 vCPU / 4 GB VPS** profile. The engine is single-threaded, so one core is what counts.

| Operation | Budget |
|---|---|
| `readCommitGraph` (real git, all 500 refs) | ≤ 2 s |
| `buildSnapshot({ visible })`, ~40 visible rows | ≤ 300 ms |
| one `aheadBehind` / `compare` | ≤ 20 ms |
| peak memory (graph + snapshot) | ≤ 300 MB |

Measured with `pnpm --filter @app/git-graph bench` (`bench/scale.bench.ts`); results under
"Benchmark results" below.

### Benchmark results (2026-11-22)

Machine: Intel i5-11400H laptop, Node 24, git 2.43, one core used. Not the VPS: budgets keep ≥ 2.7×
headroom so a slower VPS core (expect ~1.5–2× slower) still fits. "Cold" = graph just loaded from the
cache file, nothing cached. Mean of 5–30 runs.

| Operation | Before T6a | After | Budget |
|---|---|---|---|
| `readCommitGraph`, real git, 500 refs, 50 000 commits | — | 293 ms | ≤ 2 s |
| `new CommitGraph(commits)` | 28 ms | 21 ms | |
| `loadGraph` (graph cache file → graph) | — | 23 ms | |
| `buildSnapshot({ visible: 40 rows })`, cold | — | 109 ms | ≤ 300 ms |
| `buildSnapshot` every row, cold | 673 ms | 110 ms | |
| ↳ of which `pickCompareWith` every branch | 495 ms | 100 ms | |
| `pickCompareWith({ only: 40 visible })` | — | 53 ms | |
| one `aheadBehind` / `compare`, cold, worst pair (oldest branch vs main) | — | 6 ms | ≤ 20 ms |
| memory retained by read + graph + full snapshot | | 30 MB | |
| peak RSS growth during read + graph + full snapshot | — | +22 MB | ≤ 300 MB |
| graph cache file | | 2 MB | |

`visible` saves little on its own: most of a snapshot is picking compare-with for every row, which the
lazy table still does because the tree layout (row order, collapsible subtrees) needs every row's parent.
What `visible` skips is ahead/behind, merge base and drawn commits for the rows off screen.

Branch tree engine (lane T). Spec: `tasks/T-branch-tree.md`; behavior ported from
`docs/branch-tree/prototype.html` (`reach`, `aheadBehind`, `equivalence`, `contentMerged`, `prMerge`,
`closest`, `inferBase`, `chooseBase`, `compareMap`, `branchOrder`).

| Entry | Runtime | What |
|---|---|---|
| `@app/git-graph` | any (pure) | `CommitGraph` (ahead/behind, merge bases, ancestry), `compare`, `pickCompareWith`, `buildSnapshot`, `NOT_COMPUTED`, `serializeGraph`/`parseGraph`, `prMerge`, `detectMerged`, `needsContentCheck`, `matchPatchIds`, `contentMerged`, `mergedByContent`, `whyShort`/`whyLong` |
| `@app/git-graph/git` | Node | `runGit` (no shell, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, scrubbed errors), `readCommitGraph`, `patchIds`, `mergeTreeId`, `treeId`, `withContentWorkspace`, `detectMergedWithFallbacks`, `assertNoContents`, `saveGraph`/`loadGraph`/`refSetHash` |
| `@app/git-graph/testing` | Node, tests only | `FixtureRepo` builder, `commitsOnlyClone`, and the fixture repos with expected compare-with picks and merged states |

Privacy: the adapter only parses SHAs, parent SHAs and commit times (`%H %P %ct`). `patchIds`,
`mergeTreeId` and `treeId` need trees/blobs and are meant for the throwaway workspace, never the
commits-only cache clone.

Merged state (T3a): `detectMergedWithFallbacks(cacheGitDir, auth, input)` applies the PR record on the graph,
then runs the content check for the remaining branches in **one** `withContentWorkspace`: a temp
`git clone --bare --shared` of the cache that is a promisor clone of the real remote, so trees/blobs are
fetched into the temp dir only. The dir is removed in `finally` (and swept by prefix if a process died);
on timeout the whole git process group is killed. Pass its `content` to `buildSnapshot({ content })`.

Scale (T6a):
- **Pair queries** (`aheadBehind`, `compare`, `mergeBases`, `aheadCommits`) first try a two-colour walk
  from both commits in generation order that stops at the merge-base frontier, so they only touch the
  commits that differ. A walk that would get long (generation gap or visited commits over `max(1024, n/8)`)
  switches to reach bitsets, which are cached per commit (so per branch head) and reused: two cached sets
  answer in a word scan, or in O(1) when one contains the other. `isAncestor` is pruned by generation.
- **Lazy table**: `buildSnapshot({ visible })` computes ahead/behind/mergeBase and drawn commits only for
  `visible` rows and the rows on their compare-with chains; the others get `ahead = behind = NOT_COMPUTED`
  (`-1`) and `mergeBase = null`. Compare-with, `merged`, `pr`, `ci` are filled for every row.
  `pickCompareWith({ only })` picks just for some branches and their chains (same picks, same loop breaks).
- **On-demand compare**: `compare(graph, aSha, bSha)` → `{ ahead, behind, mergeBase }` in one walk.
- **Graph cache**: `saveGraph(cacheDir, id, graph, refs)` writes `<cacheDir>/<id>.graph` (format in
  `src/core/serialize.ts`: 20-byte SHAs, `Int32` parent offsets/indexes, `Uint32` commit seconds) with a
  hash of the ref set. `loadGraph(cacheDir, id, refs)` returns null when the file is missing, corrupt, or
  any ref changed, and the caller rebuilds with `readCommitGraph`. No ref names or messages in the file.
- Benchmark: `pnpm --filter @app/git-graph bench` (synthetic graph from `bench/generate.ts`, plus one
  real `git fast-import` repo for `readCommitGraph`).

Tests: `pnpm turbo test --filter @app/git-graph`. `test/oracle.test.ts` compares the engine with
`git rev-list --count`, `git merge-base [--all|--is-ancestor]`, `git cherry` and a real merge
(for `merge-tree`) on every branch pair of every fixture; it is skipped with a message on git < 2.38.
`test/scale.test.ts` checks the walk, bitset and cached paths against a naive set-based oracle on random
DAGs (criss-cross, octopus, missing parents, walks over budget), the lazy table against the full one, and
the graph cache round trip.
