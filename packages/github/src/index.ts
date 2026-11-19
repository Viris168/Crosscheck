// Public entry for @app/github (lane A). Other lanes depend on this exact surface.
export {
  Octokit,
  createOctokit,
  getAppOctokit,
  getInstallationOctokit,
  readAppCredentials,
  resetGithubClients,
  setInstallationAuthForTesting,
  type GithubAppCredentials,
} from './octokit';
export {
  MAX_PR_FILES,
  fetchFileText,
  fetchPullRequest,
  fetchPullRequestFiles,
  splitFullName,
  toGithubError,
  type PrMeta,
} from './fetch';
export { signWebhookBody, verifyWebhookSignature } from './signature';
export { MergeError, mergePullRequest, type MergeFailureReason, type MergeMethod } from './merge';
export {
  GithubApiError,
  fetchOrgMembership,
  fetchRepoPermission,
  isRepoCollaborator,
  listUserInstallationIds,
  permissionAtLeast,
  type RepoPermission,
} from './permissions';
