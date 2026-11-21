// Public entry for @app/git-graph (lane T). Pure: no I/O, safe for any runtime.
// The git adapter lives at '@app/git-graph/git'; the fixture builder at '@app/git-graph/testing'.
export { CommitGraph, UnknownCommitError, type CommitInput } from './core/graph';
export {
  LONG_LIVED,
  pickCompareWith,
  branchOrder,
  whyShort,
  whyLong,
  type BranchInput,
  type PrRecord,
  type CompareInput,
  type CompareChoice,
  type Lookup,
} from './core/compare-with';
export {
  matchPatchIds,
  contentMerged,
  equivalence,
  mergedByContent,
  type CherryLine,
  type EquivalenceKind,
  type EquivalenceInput,
} from './core/equivalence';
export { buildSnapshot, type SnapshotInput, type SnapshotBranchInput } from './core/snapshot';
export {
  prMerge,
  detectMerged,
  needsContentCheck,
  type BranchRef,
  type ContentFacts,
  type ContentFactsLookup,
  type DetectMergedInput,
} from './core/merged';
export type * from './types';
