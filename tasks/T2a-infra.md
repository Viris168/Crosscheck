# T2a — Git in the image, clone cache volume, App permissions (Lane G)

**Wave 1** · **Branch:** `feat/t2a-infra` · **Lane:** G · **Needs merged:** nothing
**Spec:** `tasks/T-branch-tree.md` → "Decisions" 2, "GitHub App changes".

## You own (edit only these)
- `infra/docker/web.Dockerfile`, `infra/compose.prod.yml`, `.github/workflows/`, `docs/deploy.md`

## Do
1. **Dockerfile runner stage**: install `git` (bookworm ships 2.39; the T-spec needs ≥ 2.44 for
   `GIT_NO_LAZY_FETCH`. Use bookworm-backports or build from the Debian `trixie` package; pick one and note
   why). Keep the image non-root. `git --version` runs in a smoke step.
2. **compose.prod.yml**: named volume `repo-cache` mounted on `web` at `/var/lib/app/repos`, owned by the
   app user; `REPO_CACHE_DIR=/var/lib/app/repos`. Mention a size cap and the cleanup in `docs/deploy.md`.
3. **CI workflow**: the test job needs git ≥ 2.44 for the `@app/git-graph` oracle tests (ubuntu-latest has
   it; add `git --version` to the log).
4. **docs/deploy.md** → GitHub App section: add **Commit statuses: Read** and events **Push, Check run,
   Check suite, Status**; one paragraph on accepting new permissions for existing installations; one on the
   `repo-cache` volume (back it up? No: it is a cache, rebuilt by the next sync; say so).
5. Backups: make sure `infra/scripts/backup.sh` does **not** include `repo-cache`.

## Tests
- `docker build -f infra/docker/web.Dockerfile .` works; `docker run --rm <img> git --version` ≥ 2.44.
- `docker compose -f infra/compose.prod.yml config` validates.

## Not yours
App code. Changing the App on GitHub itself (the user does that from your doc).
