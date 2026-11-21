// Node-only git adapter for @app/git-graph (import from '@app/git-graph/git', not the root entry).
export {
  runGit,
  scrub,
  buildGitEnv,
  GitError,
  type RunGitOptions,
  type GitResult,
} from './run-git';
export {
  readCommitGraph,
  patchIds,
  mergeTreeId,
  treeId,
  type ReadCommitGraphOptions,
} from './read';
export {
  withContentWorkspace,
  sweepStaleWorkspaces,
  WorkspaceTimeoutError,
  WORKSPACE_PREFIX,
  type ContentWorkspace,
  type GitAuth,
  type WorkspaceOptions,
  type CallOptions,
} from './workspace';
export {
  detectMergedWithFallbacks,
  type MergedGraphInput,
  type DetectMergedOptions,
  type DetectMergedResult,
} from './detect-merged';
export { assertNoContents, objectCounts } from './assert-no-contents';
