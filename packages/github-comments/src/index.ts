// Public entry for @app/github-comments (lane E). Called by lane B's `review-finalize`.
export { isLineInDiff, rightSideLines } from './diff';
export { escapeInline, escapeMarkdown } from './escape';
export {
  OUTDATED_PREFIX,
  PROVIDER_LABEL,
  SUMMARY_MARKER,
  formatIssueComment,
  formatOverflowList,
  formatSummary,
  isSuggestable,
} from './format';
export {
  postReview,
  selectInlineIssues,
  type InlineSelection,
  type PostReviewArgs,
  type ReviewComment,
  type ReviewOctokit,
} from './post';
