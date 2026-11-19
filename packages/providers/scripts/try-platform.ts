// Manual smoke test: reviews a sample diff with the real platform provider and prints the JSON result.
//   pnpm --filter @app/providers try:platform
// Needs ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the repo-root .env or the environment. No database needed.
import { createPlatformProvider } from '../src/index';
import { sampleInput } from '../src/test-fixtures';

const provider = createPlatformProvider({ repoModelLookup: async () => undefined });

try {
  const result = await provider.reviewChunk(sampleInput({ chunkCount: 1 }), {
    orgId: 'try-platform',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  const e = err as { code?: string; message?: string };
  console.error(`Review failed: ${e.code ?? 'error'} - ${e.message ?? String(err)}`);
  process.exitCode = 1;
}
