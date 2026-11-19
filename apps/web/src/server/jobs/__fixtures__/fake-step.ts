// Test-only stand-in for Inngest's `step` + execution model:
// - `run(id)` is memoized per id (like persisted step results)
// - a throwing step is retried up to `retries` times unless it throws a NonRetriableError
// - a step that exhausted its retries rejects with an error carrying name + message (like StepError)
import type { StepTools } from '../deps';

export interface FakeRunner {
  step: StepTools;
  /** Mutable: read by handlers inside step callbacks, like Inngest's per-attempt `ctx.attempt`. */
  ctx: { attempt: number };
  /** Executions per step id (1 = no retry). */
  calls: Map<string, number>;
  /** Resolved step outputs by id (what Inngest would persist). */
  outputs: Map<string, unknown>;
  sent: { id: string; payload: unknown }[];
  /** Drop a memoized step so the next handler invocation re-executes it. */
  forget(id: string): void;
}

export function createFakeRunner(opts: { retries?: number } = {}): FakeRunner {
  const retries = opts.retries ?? 2;
  const memo = new Map<string, Promise<unknown>>();
  const calls = new Map<string, number>();
  const outputs = new Map<string, unknown>();
  const sent: FakeRunner['sent'] = [];
  const ctx = { attempt: 0 };

  const step: StepTools = {
    run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const hit = memo.get(id);
      if (hit) return hit as Promise<T>;
      const p = (async () => {
        for (let a = 0; ; a++) {
          ctx.attempt = a;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          try {
            const out = await fn();
            outputs.set(id, JSON.parse(JSON.stringify(out ?? null)));
            return out;
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            if (e.name === 'NonRetriableError' || a >= retries) {
              const stepError = new Error(e.message);
              stepError.name = e.name;
              throw stepError;
            }
          }
        }
      })();
      memo.set(id, p);
      return p;
    },
    async sendEvent(id, payload) {
      sent.push({ id, payload });
      return { ids: ['evt'] };
    },
  };

  return { step, ctx, calls, outputs, sent, forget: (id) => void memo.delete(id) };
}
