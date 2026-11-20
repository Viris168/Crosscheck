# Task H — Members and repo access from GitHub

**Depends on:** A, F, Foundation (all merged) · **Split into agents:** see [Agent split](#agent-split) at the
bottom. Each agent gets its own file `tasks/H*-*.md`; this file is the shared spec they all read.

## Goal
The client only installs the GitHub App. After that, GitHub is the source of truth:
- **Who is in the org:** members of the client's GitHub org (or, for a personal account, the collaborators
  on its installed repos) join automatically when they sign in.
- **Who can see a repo:** org members who are a **collaborator** on that repo on GitHub.
- **Who can change a repo:** people with **write** access to that repo on GitHub.
- **Who leaves:** people removed on GitHub lose access at their next sign-in, or right away via webhook.

There is no invite flow and no collaborator table. The client manages people on GitHub, as they already do.

## Access policy
| Action | Allowed if |
|---|---|
| Be in the org | GitHub org member (org install) or collaborator on an installed repo (personal install) |
| View repo, PRs, reviews (incl. repo lists and overview totals) | org `owner`/`admin`, **or** org member who is a GitHub collaborator on the repo (`GET /repos/{repo}/collaborators/{user}` → 204) |
| Retry / cancel / rerun a review | same as view |
| Change settings, rotate ingest token, open workflow PR, merge a PR | org `owner`/`admin` **or** GitHub permission on the repo is `write`, `maintain` or `admin` |
| Change member roles | org `owner` |

You must be an org member first. A GitHub collaborator outside the org gets nothing (on an org install).
A GitHub org member who can't open a private repo on GitHub (e.g. a team-restricted repo) can't see it here
either: reviews contain code.

**Why collaborator, not `read`:** GitHub reports `read` to every user on a public repo, so a `read` rule
would show a member every public repo of the account. GitHub's collaborator check counts only people given
access on purpose: collaborators on personal repos; for org repos also members with access through a team,
the base permission or ownership. (Found in the real-account test: a collaborator on one repo saw all 22
public repos of the account.)

Permission levels, low to high: `none` < `read` < `triage` < `write` < `maintain` < `admin`.

## Who becomes what
| Situation | Role in our org |
|---|---|
| Org has no owner, and the user is a GitHub **org admin** (org install) or **the account itself** (personal install) | `owner` |
| Any other user who passes the "be in the org" rule | `member` |
| Promoted on the Members page | `admin` (manual) |

The "no owner yet" rule fixes the install-order bug. Today, if the client installs the GitHub App before
signing in, nobody becomes owner (`ensureOrganization`, handlers.ts:83). With this rule, they become owner
when they sign in later. It also recovers an org whose owner left the GitHub org.

---

## Part 1: GitHub permission helpers (lane A: `packages/github`)
Add `src/permissions.ts` and export it from `src/index.ts`:
```ts
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/** GET /repos/{owner}/{repo}/collaborators/{username}/permission. A 404 maps to 'none'. */
export async function fetchRepoPermission(octokit: Octokit, fullName: string, login: string): Promise<RepoPermission>;

/** GET /repos/{owner}/{repo}/collaborators/{username}. true on 204, false on 404. */
export async function isRepoCollaborator(octokit: Octokit, fullName: string, login: string): Promise<boolean>;

/** GET /orgs/{org}/memberships/{username}. Returns null when the user is not an active member (404 or state 'pending'). */
export async function fetchOrgMembership(octokit: Octokit, org: string, login: string): Promise<{ role: 'admin' | 'member' } | null>;

/** GET /user/installations with a user-to-server token (all pages). Returns the installation ids. */
export async function listUserInstallationIds(userToken: string): Promise<number[]>;

/** True when `have` is at least `need` in the order none < read < triage < write < maintain < admin. */
export function permissionAtLeast(have: RepoPermission, need: RepoPermission): boolean;
```
- `fetchRepoPermission` uses `role_name` (it includes `maintain`/`triage`) and falls back to `permission`.
  Custom repo roles: map an unknown `role_name` through `permission`.
- On a 404 the helpers return `'none'` / `false` / `null`. Any other error goes through `toGithubError`.
- **Never use `fetchRepoPermission(...) !== 'none'` to decide membership.** On a public repo GitHub reports
  `read` for every user. Membership on personal installs uses `isRepoCollaborator`.
- `// VERIFY:` the repo endpoints work with an installation token (**Metadata: read**, already granted); the
  org endpoint needs **Organization → Members: read** (new, see Part 6); `/user/installations` works with the
  GitHub App user token Better Auth stores.

## Part 2: Repo permission check with cache (lane A: `apps/web/src/server/github/`)
Add `permissions.ts` and export it from `index.ts`:
```ts
export async function getRepoPermission(input: {
  githubInstallationId: number; githubRepoId: number; fullName: string; login: string;
}): Promise<RepoPermission>;
export async function invalidateRepoPermission(githubRepoId: number, login: string): Promise<void>;
```
- Cache results in Redis: key `gh:perm:{githubRepoId}:{login.toLowerCase()}`, TTL **300s**. Cache
  `'none'` too, so a non-collaborator can't spam GitHub. Never cache an error.
- If Redis is down, skip the cache and call GitHub directly.
- Re-export `RepoPermission` and `permissionAtLeast` so `apps/web` code imports them from `@/server/github`.

## Part 3: Membership sync on sign-in (lane A + B + Foundation hook)
Add `membership.ts` in `apps/web/src/server/github/` and export it from `index.ts`:
```ts
/** Adds/removes the user's org memberships to match GitHub. Safe to run repeatedly. */
export async function syncUserMemberships(userId: string): Promise<{ joined: string[]; left: string[] }>;
```
**Which installations to check** (don't loop over every tenant):
- **Join candidates:** `listUserInstallationIds(userToken)` with the user's GitHub token from Better Auth
  (`auth.api.getAccessToken({ body: { providerId: 'github', userId } })`, which refreshes expired GitHub App
  user tokens). `// VERIFY:` the call and that refresh works for GitHub App user tokens. If there's no usable
  token, there are no join candidates (log it, don't fail).
- **Leave candidates:** the installations of every org the user is already a `Member` of.
- Only installations we have a row for, whose org has at least one active repo.

**For each candidate** (decide with the **installation** token; `/user/installations` only narrows the list):
1. Read `user.login`. If it is null, stop and do nothing.
2. **Org install** (`githubAccountType === 'Organization'`): `fetchOrgMembership(githubAccountLogin, login)`.
   **Personal install** (`'User'`): in the org if `login` equals the account login (case-insensitive), or
   `isRepoCollaborator` is true on any active repo of that installation (stop at the first hit).
   **`githubAccountType` is null** (an old org): skip it; it's set when the client accepts the new permissions.
3. **In the org on GitHub but not in ours:** create a `Member` row (upsert on `organizationId_userId`). The
   role is `owner` if the org has no owner and the user is a GitHub org admin or the personal account itself;
   otherwise `member`. Decide "has no owner" and write inside one transaction so two concurrent syncs can't
   create two owners.
4. **In ours but not on GitHub anymore:** delete the `Member` row, whatever its role.
5. **Errors:** skip that installation and leave its rows unchanged. Never add or remove someone because of
   an error. A 403 from `fetchOrgMembership` (permission not accepted yet) also sets
   `Installation.needsMemberPermission = true`. Log only `{ userId, orgId }`.

Where it runs:
- **On sign-in:** Better Auth `databaseHooks.session.create.after` in `apps/web/src/server/auth.ts`
  (Foundation file) sends the Inngest event `user/signed-in { userId }`. An Inngest function in
  `apps/web/src/server/jobs` (lane B) calls `syncUserMemberships`, with concurrency limit 1 keyed by
  `event.data.userId`. Sign-in doesn't wait on GitHub, and a failed send never blocks sign-in.
- **On the "No organization yet" page:** a **Check again** button calls `POST /api/me/sync-orgs`, which
  runs the sync inline and returns the orgs joined. Rate limit: 5 per user per minute (Redis), 429 after.

`Organization.githubAccountType` (`'Organization' | 'User'`) is set by `ensureOrganization` from
`installation.account.type`. Existing installs get it when they accept the new permissions: GitHub sends
`installation.new_permissions_accepted`, which already runs `ensureOrganization`. That event also clears
`needsMemberPermission`.

## Part 4: Instant removal via webhooks (lane A: `server/github/webhook.ts` + `handlers.ts`)
| GitHub event | User id is at | Action |
|---|---|---|
| `organization.member_removed` | `membership.user.id` | delete that user's `Member` row in the org whose `githubAccountLogin` matches `organization.login` |
| `organization.member_added` | – | nothing (they join at next sign-in) |
| `member.removed` / `member.edited` (repo collaborators) | `member.id` | `invalidateRepoPermission(repository.id, member.login)`. On a personal install, also run `syncUserMemberships` for that user |
| `installation.deleted` | – | unchanged (repos deactivated) |

- Match a user by `Account.accountId = String(<user id>)` with `providerId: 'github'`, not by login.
- Unknown users (never signed in) are a no-op. Add zod payload schemas in `payloads.ts`.
- `// VERIFY:` both payload shapes against GitHub's webhook docs.

## Part 5: Repo access checks, routes and Members page (lane F)
1. `apps/web/src/lib/server/access.ts`:
   - `requireRepoAccess(userId, repoId)` checks **collaborator**: load the repo with `include: { installation: true }`,
     `requireOrgMember(userId, repo.orgId)`; owner/admin pass without a GitHub call; otherwise `user.login`
     must be set (403 "Link your GitHub account") and `getRepoCollaborator` (cached like `getRepoPermission`)
     must be true (else 403 `'No access to this repository on GitHub'`).
   - Add `requireRepoWrite(userId, repoId)`: same, but needs `write`+ (403
     `'Requires write access to this repository on GitHub'`).
   - Add `visibleRepoIds(userId, orgId): Promise<string[]>` for lists: owner/admin see all; members see repos
     they are a collaborator on (lookups in parallel, at most 5 at a time). Drop a repo whose lookup errors.
   - **Fail closed:** a GitHub error on a single-repo check gives a 502 `github_error`, never access.
   - Drop the `roles` parameter; `ADMIN_ROLES` stays only as the owner/admin shortcut.
2. Switch to `requireRepoWrite`: `settings` (PUT), `ingest-token/rotate`, `setup/workflow-pr`,
   `pulls/[number]/merge`.
3. `requireReviewAccess` and `requirePullAccess` go through `requireRepoAccess`.
4. `GET /api/repos` and the overview (`lib/server/overview.ts` + route) only count repos in `visibleRepoIds`.
5. Repo settings GET returns `canEdit`; the settings page disables the edit controls when it's false, with a
   tooltip.
6. **Settings → Members page** (`app/(dashboard)/settings/members`):
   - List the members with avatar, GitHub login and role.
   - The owner can change any role (`owner`/`admin`/`member`); that covers transferring ownership. The org must
     always keep at least one owner (409 otherwise).
   - There is **no Add or Remove button.** The page shows "Members come from GitHub. Add or remove people in
     your GitHub organization." Removing a person here would be undone at their next sign-in.
   - When `needsMemberPermission` is true, the owner sees a banner: "Accept the new GitHub App permissions to
     sync members", linking to the installation settings on GitHub.
   - Routes: `GET /api/orgs/[orgId]/members` (any member) and
     `PATCH /api/orgs/[orgId]/members/[memberId]` (owner only).
7. `no-org.tsx`: add the **Check again** button (Part 3).

## Part 6: GitHub App settings (lane G: `docs/deploy.md` §3.3)
- **Add an organization permission:** Members **Read**.
- **Add event subscriptions:** Organization, Member.
- Existing installs get a "new permissions requested" prompt on GitHub; the client must accept it. Until
  then, `fetchOrgMembership` gets a 403: change nothing and set `needsMemberPermission` (Part 3).
  `// VERIFY:` how GitHub reports a missing permission (403 vs 404).

## Better Auth hardening (Foundation, in `auth.ts`)
- GitHub is the only source of members, so turn off Better Auth's own org management:
  `allowUserToCreateOrganization: false`, and `disabledPaths` for every `/organization/*` endpoint that
  creates, updates or deletes orgs, members or invitations. **Keep `/organization/set-active`**: the org
  switcher uses it. Today `/api/auth/organization/{create,invite-member,remove-member,update-member-role}`
  are live (they answer 400, not 404), and an `admin` can change roles through them.
- `overrideUserInfoOnSignIn: true` on the GitHub provider. In better-auth 1.7.25, `mapProfileToUser` runs
  again on sign-in only with this flag, so without it a renamed GitHub account keeps its old `login`.
- Encrypt stored OAuth tokens (`account.encryptOAuthTokens: true`). `// VERIFY:` the option and how existing
  plaintext rows are read.

## Contract changes (Foundation)
- `packages/shared/src/events.ts`: event `'user/signed-in': { userId: string }` (in `events` and `eventSchemas`).
- `packages/db`: `Organization.githubAccountType String?`; `Installation.needsMemberPermission Boolean
  @default(false)`; one migration.
- `packages/shared/src/api/orgs.ts`: `MemberParams { orgId, memberId }`, `OrgMemberSchema { id, userId,
  login, name, avatarUrl, role }`, `ListMembersResponse { members, needsMemberPermission }`,
  `UpdateMemberBody { role }`, `UpdateMemberResponse`, `SyncOrgsResponse { joined, left }`.
- `packages/shared/src/api/repos.ts`: `canEdit: boolean` on the repo settings GET response.
- `apps/web/src/server/auth.ts`: the `session.create.after` hook plus the hardening above.

## Sign-in stays GitHub-only
- The website's only sign-in is **Sign in with GitHub** (`server/auth.ts`, `components/auth-buttons.tsx`).
  Do not add email/password or magic-link sign-in in this task. Every user must have a GitHub login for
  this design to work.
- If email sign-in is added later, an email-only user:
  - joins no org and can't see or change repos
  - sees "Connect your GitHub account to see your organization", with a **Connect GitHub** button (Better
    Auth account linking)
  - gets the normal `syncUserMemberships` run once linked
- **Never grant org access by matching email addresses.** GitHub emails can be private or unverified, so
  matching by email would let someone sign up with a client's email address and join their org. Only a
  verified GitHub account (`Account.accountId` / `user.login`) grants access.

## Security notes
- `user.login` comes from GitHub OAuth (`input: false`), so users can't set it. Match webhook users by
  GitHub numeric id (`Account.accountId`), never by login.
- Fail closed everywhere: a GitHub or Redis error never grants access or adds a member. It also never
  removes one; removal only follows a clear "not a member" answer.
- Never log tokens (installation or user). Inngest events carry `userId` only.

## Tests
- `packages/github`: `fetchRepoPermission` (role mapping, custom role, 404 to `'none'`, 500 rethrows),
  `isRepoCollaborator` (204/404/500), `fetchOrgMembership` (active, pending to `null`, 404 to `null`, 403
  rethrows), `listUserInstallationIds` (pagination), `permissionAtLeast`. Use msw or nock.
- `server/github/permissions`: cache hit, cache miss with a 300s TTL, `'none'` cached, error not cached,
  Redis down.
- `server/github/membership`:
  - org install: member joins as `member`; GitHub org admin joins as `owner` when there is no owner
  - org install: becomes `member` when the org already has an owner; outside collaborator doesn't join
  - removed on GitHub: row deleted (also when it was the owner)
  - personal install: the account itself joins as owner; a collaborator joins; a stranger doesn't, **also on a
    public repo**
  - candidates: only `/user/installations` + existing memberships; no user token → removals only
  - null `githubAccountType`: skipped; GitHub error: nothing changes; 403: sets `needsMemberPermission`
- Webhooks: `organization.member_removed` deletes the row; unknown user is a no-op; `member.removed`
  invalidates the cache; `new_permissions_accepted` sets `githubAccountType` and clears the flag.
- Routes (extend `dashboard-routes.test.ts`):
  - `requireRepoAccess`: owner/admin with no GitHub call; member with read allowed; member with `none` 403
  - `requireRepoWrite`: owner/admin allowed with no GitHub call; member with write allowed; member with read
    gets 403; no login gets 403; outsider gets 403; GitHub 500 gives 502
  - `GET /api/repos` and overview hide repos the member can't read
  - Members PATCH: owner only; can't remove the last owner
- Commands: `pnpm turbo test --filter @app/github` and `pnpm --filter @app/web test -- src/lib src/server src/app/api`.

## Done when
- A teammate in the client's GitHub org signs in and sees the repos they were given access to on GitHub, with no invite.
- Sign-in is still GitHub-only, and no code grants access by matching email addresses.
- A collaborator with write access can save repo settings; one with read access gets 403.
- Someone removed from the GitHub org loses access right away (webhook) or at their next sign-in.
- Installing before signing in still ends with the installer as owner.
- `/api/auth/organization/*` mutations (except `set-active`) return 404.
- All tests pass, and each PR lists its `// VERIFY:` items.

---

## Agent split
Max 3 agents at a time (see `tasks/README.md`). Start a wave only when the one before it is merged.

| Wave | Task file | Branch | Lane | Scope | Needs merged |
|---|---|---|---|---|---|
| 1 | `H0-contracts.md` | `feat/h0-contracts` | Foundation | Contract changes + Better Auth hardening + sign-in hook | – |
| 1 | `H1-permissions.md` | `feat/h1-permissions` | A | Parts 1 and 2 | – |
| 1 | `H6-app-permissions-docs.md` | `feat/h6-app-permissions-docs` | G | Part 6 | – |
| 2 | `H2-membership.md` | `feat/h2-membership` | A | Parts 3 (sync function) and 4 | H0, H1 |
| 2 | `H3-repo-access.md` | `feat/h3-repo-access` | F | Part 5.1–5.5 | H0, H1 |
| 2 | `H4-members-page.md` | `feat/h4-members-page` | F | Part 5.6 | H0 |
| 3 | `H5a-signin-job.md` | `feat/h5a-signin-job` | B | Part 3 Inngest function | H2 |
| 3 | `H5b-check-again.md` | `feat/h5b-check-again` | F | Part 5.7 + `POST /api/me/sync-orgs` | H2 |
| 4 | – | – | integration | Real-GitHub test of the "Done when" list | all |

H1 and H6 never touch `packages/shared` or `packages/db`; H1 defines `RepoPermission` itself in
`@app/github`. H3 and H4 are both lane F but own different files (listed in their task files).
