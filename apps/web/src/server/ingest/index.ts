// Public entry for lane D (Ingest): results POSTed by the user's Claude / Codex GitHub Action.
export { handleIngestReview } from './handler';
export { INGEST_RATE_LIMIT, INGEST_RATE_WINDOW_SECONDS } from './rate-limit';
