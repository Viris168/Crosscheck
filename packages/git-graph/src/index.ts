// Public entry for @app/git-graph (lane T). Pure: no I/O, safe for any runtime.
// The git adapter lives at '@app/git-graph/git'; the fixture builder at '@app/git-graph/testing'.
export {
  CommitGraph,
  UnknownCommitError,
  compare,
  type CommitInput,
  type CompareResult,
} from './core/graph';
export { serializeGraph, parseGraph, GraphFormatError } from './core/serialize';
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
export {
  buildSnapshot,
  NOT_COMPUTED,
  type SnapshotInput,
  type SnapshotBranchInput,
} from './core/snapshot';
export {
  prMerge,
  detectMerged,
  needsContentCheck,
  inferMergeMethod,
  type BranchRef,
  type ContentFacts,
  type ContentFactsLookup,
  type DetectMergedInput,
} from './core/merged';
export type * from './types';
