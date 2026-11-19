import { ProviderError, type ReviewChunkInput } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeDeps, fakeProvider } from './__fixtures__/deps';
import { createFakeRunner } from './__fixtures__/fake-step';
import { createFakeStore } from './__fixtures__/fake-store';
import { PATCH_MARKER, file, hugePr, pr136 } from './__fixtures__/files';
import { reviewStartHandler } from './review-start';

const event = { data: { reviewId: 'rev_1', orgId: 'org_1' } };

function run(deps: ReturnType<typeof makeDeps>, runner = createFakeRunner()) {
  const result = reviewStartHandler(
    {
      event,
      step: runner.step,
      get attempt() {
        return runner.ctx.attempt;
      },
    },
    deps,
  );
  return { result, runner };
}

describe('review-start', () => {
  it('small PR: one chunk step, issues saved, finalize sent', async () => {
    const db = createFakeStore();
    const deps = makeDeps({
      store: db.store,
      files: [file('src/a.ts'), file('src/b.ts')],
      fileText: { 'AGENTS.md': 'rules' },
    });
    const { result, runner } = run(deps);
    expect(await result).toEqual({ status: 'finalizing', chunks: 1, failedChunks: 0 });
    expect([...runner.calls.keys()]).toEqual([
      'load',
      'mark-running',
      'plan',
      'chunk-0',
      'finish-chunks',
    ]);
    expect(runner.sent).toEqual([
      { id: 'finalize', payload: { name: 'review/finalize', data: { reviewId: 'rev_1' } } },
    ]);
    expect(db.review).toMatchObject({
      status: 'running',
      filesTotal: 2,
      filesDone: 2,
      riskScore: 30,
      summary: 'AI_SUMMARY chunk 0',
      errorCode: null,
    });
    expect(db.issues()).toHaveLength(1);
  });

  it('passes context and repo model to the provider', async () => {
    const provider = fakeProvider();
    const db = createFakeStore({ settings: { model: 'claude-opus-5-5' } });
    const deps = makeDeps({
      store: db.store,
      files: [file('src/a.ts')],
      provider,
      fileText: { 'AGENTS.md': 'rules', 'CHANGE_NOTES.md': 'notes' },
    });
    let ctxSeen: unknown;
    provider.reviewChunk = async function (input, ctx) {
      ctxSeen = ctx;
      return { risk_score: 1, summary: '', issues: [] };
    };
    await run(deps).result;
    expect(ctxSeen).toEqual({ orgId: 'org_1', model: 'claude-opus-5-5' });
  });

  it('136-file PR: one step per chunk, all files reviewed', async () => {
    const provider = fakeProvider();
    const db = createFakeStore();
    const deps = makeDeps({ store: db.store, files: pr136(), provider });
    const { result, runner } = run(deps);
    const out = await result;
    const chunkSteps = [...runner.calls.keys()].filter((k) => k.startsWith('chunk-'));
    expect(out).toMatchObject({ status: 'finalizing', failedChunks: 0 });
    expect(chunkSteps.length).toBeGreaterThan(1);
    expect(chunkSteps.length).toBe(provider.inputs.length);
    expect(provider.inputs.flatMap((i) => i.files.map((f) => f.path))).toHaveLength(136);
    expect(db.review.filesDone).toBe(136);
    expect(db.review.summary).toContain('**Part 1/');
  });

  it('step outputs never contain patches or AI text', async () => {
    const db = createFakeStore();
    const deps = makeDeps({ store: db.store, files: pr136() });
    const { result, runner } = run(deps);
    await result;
    const persisted = JSON.stringify([...runner.outputs.values()]);
    expect(persisted).not.toContain(PATCH_MARKER);
    expect(persisted).not.toContain('AI_SUMMARY');
    expect(JSON.stringify(runner.sent)).not.toContain(PATCH_MARKER);
  });

  it('never sends secret-like files or lockfiles to the provider', async () => {
    const provider = fakeProvider();
    const db = createFakeStore();
    await run(
      makeDeps({
        store: db.store,
        provider,
        files: [file('src/a.ts'), file('.env.local'), file('k.pem'), file('yarn.lock')],
      }),
    ).result;
    expect(provider.inputs.flatMap((i) => i.files.map((f) => f.path))).toEqual(['src/a.ts']);
  });

  it('huge PR: too_large warning, riskiest files reviewed, still finalizes', async () => {
    const provider = fakeProvider();
    const db = createFakeStore();
    const { result } = run(makeDeps({ store: db.store, files: hugePr(), provider }));
    expect(await result).toMatchObject({ status: 'finalizing' });
    expect(db.review.errorCode).toBe('too_large');
    expect(db.review.errorMessage).toMatch(/PR too large/);
    expect(provider.inputs[0]!.files[0]!.path).toMatch(/auth/);
  });

  it('skips a review that is no longer queued (e.g. cancelled)', async () => {
    const db = createFakeStore({ status: 'cancelled' });
    const provider = fakeProvider();
    const { result, runner } = run(makeDeps({ store: db.store, files: [file('a.ts')], provider }));
    expect(await result).toEqual({ status: 'skipped', reason: 'status_cancelled' });
    expect(provider.inputs).toHaveLength(0);
    expect(runner.sent).toHaveLength(0);
    expect(db.review.status).toBe('cancelled');
  });

  it('partial failure: other chunks still run, failed files recorded, completes via finalize', async () => {
    const provider = fakeProvider(async (input: ReviewChunkInput) => {
      if (input.chunkIndex === 1) throw new ProviderError('rate_limited', 'HTTP 429');
      return { risk_score: 50, summary: 's', issues: [] };
    });
    const db = createFakeStore();
    const { result, runner } = run(makeDeps({ store: db.store, files: pr136(), provider }));
    expect(await result).toMatchObject({ status: 'finalizing', failedChunks: 1 });
    expect(runner.calls.get('chunk-1')).toBe(3); // 1 try + 2 retries
    expect(runner.calls.get('chunk-0')).toBe(1);
    expect(db.review.errorCode).toBeNull();
    expect(db.review.errorMessage).toMatch(
      /Partial review: \d+ of 136 files could not be reviewed \(rate_limited\): src\/module-/,
    );
    expect(db.review.filesDone).toBeLessThan(136);
    expect(runner.sent).toHaveLength(1);
  });

  it('total failure: failed with the most specific code, provider_auth not retried, no finalize', async () => {
    const provider = fakeProvider(async (input) => {
      throw new ProviderError(input.chunkIndex === 0 ? 'provider_auth' : 'timeout', 'nope');
    });
    const db = createFakeStore();
    const { result, runner } = run(makeDeps({ store: db.store, files: pr136(), provider }));
    expect(await result).toEqual({ status: 'failed', errorCode: 'provider_auth' });
    expect(runner.calls.get('chunk-0')).toBe(1);
    expect(runner.calls.get('chunk-1')).toBe(3);
    expect(db.review).toMatchObject({ status: 'failed', errorCode: 'provider_auth' });
    expect(runner.sent).toHaveLength(0);
  });

  it('invalid_output is retried exactly once', async () => {
    const provider = fakeProvider(async () => {
      throw new ProviderError('invalid_output', 'bad json');
    });
    const db = createFakeStore();
    const { result, runner } = run(makeDeps({ store: db.store, files: [file('a.ts')], provider }));
    expect(await result).toEqual({ status: 'failed', errorCode: 'invalid_output' });
    expect(runner.calls.get('chunk-0')).toBe(2);
  });

  it('GitHub failure while planning → failed github_error after retries', async () => {
    const db = createFakeStore();
    const deps = makeDeps({ store: db.store, files: [] });
    deps.github.listFiles = async () => {
      throw new ProviderError('github_error', 'GitHub API error (502) on pulls.listFiles');
    };
    const { result, runner } = run(deps);
    expect(await result).toEqual({ status: 'failed', errorCode: 'github_error' });
    expect(runner.calls.get('plan')).toBe(3);
    expect(db.review.errorMessage).toBe('GitHub API error (502) on pulls.listFiles');
  });

  it('drops AI issues outside the chunk or failing the schema', async () => {
    const provider = fakeProvider(async () => ({
      risk_score: 10,
      summary: 's',
      issues: [
        { file: 'a.ts', line: 1, severity: 'high', category: 'bug', title: 'ok', explanation: 'e' },
        {
          file: 'not-in-chunk.ts',
          line: 1,
          severity: 'high',
          category: 'bug',
          title: 'x',
          explanation: 'e',
        },
        {
          file: 'a.ts',
          line: 0,
          severity: 'high',
          category: 'bug',
          title: 'bad line',
          explanation: 'e',
        },
      ],
    }));
    const db = createFakeStore();
    await run(makeDeps({ store: db.store, files: [file('a.ts')], provider })).result;
    expect(db.issues().map((i) => i.title)).toEqual(['ok']);
  });

  describe('idempotency', () => {
    it('a second review/requested for the same review is a no-op', async () => {
      const provider = fakeProvider();
      const db = createFakeStore();
      const deps = makeDeps({ store: db.store, files: [file('a.ts'), file('b.ts')], provider });
      await run(deps).result;
      const second = await run(deps).result;
      expect(second).toEqual({ status: 'skipped', reason: 'status_running' });
      expect(provider.inputs).toHaveLength(1);
      expect(db.issues()).toHaveLength(1);
    });

    it('re-running a chunk step does not duplicate issues or summary parts', async () => {
      const db = createFakeStore();
      const deps = makeDeps({ store: db.store, files: pr136() });
      const runner = createFakeRunner();
      await run(deps, runner).result;
      const issuesBefore = db.issues().length;
      const summaryBefore = db.review.summary;
      runner.forget('chunk-0');
      runner.forget('finish-chunks');
      await run(deps, runner).result;
      expect(runner.calls.get('chunk-0')).toBe(2);
      expect(db.issues()).toHaveLength(issuesBefore);
      expect(db.review.summary).toBe(summaryBefore);
      expect(db.review.filesDone).toBe(136);
    });
  });
});
