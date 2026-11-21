# T6a — Engine at scale + on-demand compare (Lane T, milestone 6)

**Wave 5** · **Branch:** `feat/t6a-engine-scale` · **Lane:** T · **Needs merged:** T3a
**Spec:** `tasks/T-branch-tree.md` → "Milestones" row 6, "Contracts → API" (GET `/tree/compare`).

## You own (edit only these)
- `packages/git-graph/**`

## Do
1. **Set the budget first** (write it at the top of `packages/git-graph/README.md` and in the PR): on a
   generated repo with **500 branches and 50 000 commits**, on the 2 vCPU / 4 GB VPS profile. Proposed:
   `readCommitGraph` ≤ 2 s, `buildSnapshot` (visible rows only) ≤ 300 ms, one `aheadBehind` ≤ 20 ms,
   peak memory ≤ 300 MB. Change the numbers if the benchmark says otherwise, but keep them written down.
2. **Faster core**: generation numbers (topological levels) to prune ancestor walks; reuse bitsets per
   branch head; `aheadBehind` via a two-colour walk that stops at the merge-base frontier.
3. **Lazy table**: `buildSnapshot({ visible: string[] })` computes compare-with + ahead/behind only for
   `visible` branches and the branches on their compare-with chains; others get `ahead/behind = -1`
   (meaning "not computed"; coordinate the sentinel with T6b). `commits` limited to what those rows draw.
4. **Graph cache**: `serializeGraph` / `loadGraph` to a compact binary file
   (`<cache>/<id>.graph`: SHAs as 20-byte buffers + `Int32Array` parents + `Uint32Array` times), so the API can
   compute without re-running `rev-list`. Invalidate when any ref changes (store the ref-set hash in it).
5. `compare(graph, a, b) → { ahead, behind, mergeBase }` for the on-demand endpoint.
6. **Benchmark** `bench/scale.bench.ts` (vitest bench) with a generator script (synthetic graph, no real git
   needed for most of it; one real-git run for `readCommitGraph`).

## Tests
Oracle suite from T1 still passes. Benchmark meets the budget (CI runs it non-blocking, logs results).

## Not yours
The endpoint and UI (T6b), job changes (T7 wires `serializeGraph` into the sync if T6b needs it).
