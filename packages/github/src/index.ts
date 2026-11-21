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
  fetchAuthenticatedUser,
  fetchOrgMembership,
  fetchRepoPermission,
  isRepoCollaborator,
  listUserInstallationIds,
  permissionAtLeast,
  type GithubUserProfile,
  type RepoPermission,
} from './permissions';
export {
  ciBucket,
  combineCi,
  fetchCiState,
  gitAuthForInstallation,
  listBranches,
  listPullRequestsForTree,
  resetTreeWarningsForTesting,
  type CiBucket,
  type FetchCiStateOptions,
  type GitAuth,
  type GitAuthOptions,
  type GitAuthRepo,
  type ListPullRequestsForTreeOptions,
  type TreeBranch,
  type TreePr,
  type TreeWarn,
} from './tree';
