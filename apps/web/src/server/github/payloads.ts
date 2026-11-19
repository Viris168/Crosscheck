import { z } from 'zod';

// The subset of GitHub webhook payloads we read. Webhook bodies are untrusted: parse, don't cast.
// Unknown fields are stripped; only ids/metadata are kept (never code).

const Account = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  type: z.string().optional(),
});

const Sender = z.object({
  id: z.number().int(),
  login: z.string(),
  type: z.string().optional(),
});

const InstallationRef = z.object({ id: z.number().int() });

const InstallationRepo = z.object({
  id: z.number().int(),
  full_name: z.string().min(3),
});

export const InstallationPayload = z.object({
  action: z.string(),
  installation: InstallationRef.extend({ account: Account }),
  repositories: z.array(InstallationRepo).nullish(),
  sender: Sender,
});
export type InstallationPayload = z.infer<typeof InstallationPayload>;

export const InstallationRepositoriesPayload = z.object({
  action: z.string(),
  installation: InstallationRef.extend({ account: Account }),
  repositories_added: z.array(InstallationRepo).default([]),
  repositories_removed: z.array(InstallationRepo).default([]),
  sender: Sender,
});
export type InstallationRepositoriesPayload = z.infer<typeof InstallationRepositoriesPayload>;

const Repository = z.object({ id: z.number().int(), full_name: z.string() });

export const PullRequestData = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  user: z.object({ login: z.string() }).nullish(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional().default(false),
  merged: z.boolean().nullish(),
  head: z.object({ sha: z.string().min(1), ref: z.string() }),
  base: z.object({ ref: z.string() }),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
});
export type PullRequestData = z.infer<typeof PullRequestData>;

export const PullRequestPayload = z.object({
  action: z.string(),
  pull_request: PullRequestData,
  repository: Repository,
  installation: InstallationRef.optional(),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export const IssueCommentPayload = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int(),
    /** Present only when the issue is a pull request. */
    pull_request: z.object({}).passthrough().nullish(),
  }),
  comment: z.object({
    body: z.string().nullish(),
    author_association: z.string().optional(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullish(),
  }),
  repository: Repository,
  installation: InstallationRef.optional(),
  sender: Sender.optional(),
});
export type IssueCommentPayload = z.infer<typeof IssueCommentPayload>;

const GithubUser = z.object({ id: z.number().int(), login: z.string().min(1) });

/** `organization` event. `membership` is present on member_added / member_removed / member_invited. */
// VERIFY: shape against https://docs.github.com/webhooks/webhook-events-and-payloads#organization
export const OrganizationPayload = z.object({
  action: z.string(),
  membership: z.object({ user: GithubUser.nullable() }).optional(),
  organization: z.object({ id: z.number().int(), login: z.string().min(1) }),
  installation: InstallationRef.optional(),
});
export type OrganizationPayload = z.infer<typeof OrganizationPayload>;

/** `member` event: a repository collaborator was added, removed or had their permission edited. */
// VERIFY: shape against https://docs.github.com/webhooks/webhook-events-and-payloads#member
export const MemberPayload = z.object({
  action: z.string(),
  member: GithubUser,
  repository: Repository,
  installation: InstallationRef.optional(),
});
export type MemberPayload = z.infer<typeof MemberPayload>;
