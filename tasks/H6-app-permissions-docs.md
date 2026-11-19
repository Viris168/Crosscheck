# H6 — GitHub App permissions docs (lane G)

**Wave 1** · **Branch:** `feat/h6-app-permissions-docs` · **Lane:** G · **Needs merged:** nothing
**Spec:** `tasks/H-repo-collaborators.md` → Part 6.

## You own (edit only these)
- `docs/deploy.md`

## Do
1. §3.3 (GitHub App setup): add the organization permission **Members: Read** and the event subscriptions
   **Organization** and **Member**. Keep the existing list's format.
2. A short "Upgrading an existing install" note: GitHub asks the client to accept the new permissions; until
   they do, members don't sync and the owner sees a banner on Settings → Members. Link to GitHub's docs on
   approving updated permissions.
3. Say that the GitHub App must issue user-to-server tokens (the login already uses the App's OAuth client,
   `GITHUB_CLIENT_ID`), because sign-in sync calls `GET /user/installations`. Say whether "Expire user
   authorization tokens" should stay on (it should; Better Auth refreshes them). `// VERIFY:` against GitHub's docs.

## Tests
Docs only. Check the links resolve and `pnpm format:check` passes on the file.

## Not yours
Any code. If the CI workflow needs a change, write it in the PR description instead.
