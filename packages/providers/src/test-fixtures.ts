import type { ReviewChunkInput } from '@app/shared';

// Test-only fixtures (not exported from index.ts).

export const samplePatch = `@@ -1,4 +1,6 @@
 import { db } from './db';
-export function getUser(id) {
-  return db.query('SELECT * FROM users WHERE id = ' + id);
+export async function getUser(id: string) {
+  // look up one user
+  const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);
+  return rows[0];
 }
@@ -20,2 +22,3 @@ export function other() {
   return 1;
+  // unreachable
 }
`;

export function sampleInput(overrides: Partial<ReviewChunkInput> = {}): ReviewChunkInput {
  return {
    repo: 'acme/api',
    prNumber: 7,
    headSha: 'abc123',
    baseRef: 'main',
    title: 'Use parameterized query in getUser',
    body: 'Fixes SQL injection in user lookup.',
    intentNotes: 'Security fix only; no behavior change.',
    guidelines: 'All DB access must use parameters.',
    files: [{ path: 'src/users.ts', status: 'modified', patch: samplePatch }],
    chunkIndex: 0,
    chunkCount: 2,
    ...overrides,
  };
}

export const validResultJson = {
  risk_score: 30,
  summary: 'Parameterized the query.',
  issues: [
    {
      file: 'src/users.ts',
      line: 4,
      severity: 'medium',
      category: 'bug',
      title: 'Returns undefined when no row',
      explanation: 'Callers expect a user or an error.',
    },
  ],
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Anthropic Messages API success body. */
export function anthropicMessage(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  };
}

/** OpenAI Responses API success body. */
export function openaiResponse(text: string, model = 'gpt-5') {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  };
}
