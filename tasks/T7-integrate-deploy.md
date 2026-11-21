# T7 — Integrate and deploy the branch tree (integration agent, milestone 7)

**Wave 6** · **Branch:** `feat/t7-integrate` · **Lane:** integration (may touch any T-related path; fix
wiring only, file anything bigger as a task) · **Needs merged:** T0–T6b

**Spec:** `tasks/T-branch-tree.md` (all of it).

## Do
1. Replace every remaining mock / `TODO(T0)` / local `.extend()` with the real contract or package.
2. Wire T6a's graph cache into the sync job (`serializeGraph` after `snapshot`) and the API (`loadGraph`).
3. **Links**: "Branches" link on each repo row in `components/repos/repo-list.tsx`; on the PR detail page, a
   "Show in branch tree" link that opens `/repos/:id/tree?q=<headRef>`.
4. **Caching**: GET `/tree` ETag (done in T5c) + `Cache-Control: private, no-cache`; Redis rate limits from
   T2d/T6b in place; graph cache invalidated on refresh.
5. **Cleanup job**: clones of repos not viewed in 30 days or removed from the installation are deleted from
   `REPO_CACHE_DIR` (daily cron). Leftover `mkdtemp` workspaces older than 1 h are deleted.
6. **Deploy** following `docs/deploy.md`: new App permissions + events accepted on the test org, `repo-cache`
   volume present, `git --version` in the container ≥ 2.44.
7. **e2e**: extend `scripts/e2e.ts` (or a Playwright smoke) — open Branches tab on the seed repo, see the tree.

## Check (write results in the PR)
- Every milestone's "Done when" from the T-spec, re-run on the deployed instance with a real private repo.
- `assertNoContents` on every clone in the volume.
- No `/compare/` calls to GitHub in the logs over one hour of use.
- Membership: a non-collaborator gets 404 on the page and every tree API route.
