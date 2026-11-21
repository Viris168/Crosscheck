// Run git without a shell. Every call disables prompts and lazy fetches, and errors are scrubbed of
// tokens before they can reach a log line.
import { spawn } from 'node:child_process';

export interface RunGitOptions {
  cwd?: string;
  /** extra env (e.g. the GIT_CONFIG_COUNT/KEY/VALUE auth header); wins over process.env */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** written to git's stdin */
  input?: string;
  /** exit codes that are not errors (default [0]) */
  okExitCodes?: readonly number[];
  maxBuffer?: number;
  /** abort = kill git (and with `killTree`, everything it started); rejects with a GitError */
  signal?: AbortSignal;
  /**
   * Run git in its own process group and kill the whole group on timeout/abort, so helpers git spawns
   * (e.g. the `git fetch` behind a lazy fetch) die too. POSIX only.
   */
  killTree?: boolean;
  /**
   * Allow fetching missing objects on demand (drops GIT_NO_LAZY_FETCH). ONLY for the throwaway content
   * workspace (`withContentWorkspace`), never for the commits-only cache clone.
   */
  allowLazyFetch?: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
// Inherited variables that would point git at another repository or object store.
const DROP_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/** Remove auth material from text that may be logged (stderr, messages, args). */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out
    .replace(/(extraheader\s*[=:]?\s*)[^\n]*/gi, '$1***')
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)[^\s'"]+/gi, '$1***')
    .replace(/x-access-token:[^@\s'"]+/gi, 'x-access-token:***')
    .replace(/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '***')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

export function buildGitEnv(
  extra: RunGitOptions['env'] = {},
  { allowLazyFetch = false }: Pick<RunGitOptions, 'allowLazyFetch'> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  // VERIFY: GIT_NO_LAZY_FETCH needs git >= 2.44; older git ignores it (cache relies on promisor=false too).
  if (allowLazyFetch) delete env.GIT_NO_LAZY_FETCH;
  else env.GIT_NO_LAZY_FETCH = '1';
  env.LC_ALL = 'C';
  return env;
}

/** Values that must never appear in an error: anything passed as config values or auth env. */
function secretsOf(env: RunGitOptions['env'] = {}): string[] {
  return Object.entries(env)
    .filter(([k]) => /^GIT_CONFIG_VALUE_\d+$/.test(k) || /TOKEN|PASSWORD|SECRET/i.test(k))
    .flatMap(([, v]) => (v ? [v, ...headerParts(v)] : []));
}

function headerParts(v: string): string[] {
  // "AUTHORIZATION: basic <base64(x-access-token:TOKEN)>" → also hide the base64 part and the token.
  const m = /basic\s+(\S+)/i.exec(v);
  if (!m) return [];
  const b64 = m[1]!;
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const token = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '';
  return [b64, token];
}

export function runGit(args: readonly string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const env = buildGitEnv(opts.env, opts);
  const secrets = secretsOf(opts.env);
  const ok = opts.okExitCodes ?? [0];
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = scrub(
    `git ${args
      .filter((a) => !a.startsWith('-'))
      .slice(0, 1)
      .join(' ')}`.trim(),
    secrets,
  );

  const tree = Boolean(opts.killTree) && process.platform !== 'win32';
  const maxBuffer = opts.maxBuffer ?? 512 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new GitError(`${label} failed (aborted)`, null, false));
      return;
    }
    let why: 'timeout' | 'aborted' | 'maxBuffer' | null = null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env,
      detached: tree,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const kill = (reason: NonNullable<typeof why>) => {
      why ??= reason;
      if (tree && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // group already gone; fall through to the child itself
        }
      }
      child.kill('SIGKILL');
    };
    const onAbort = () => kill('aborted');
    const timer = timeout > 0 ? setTimeout(() => kill('timeout'), timeout) : undefined;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b: Buffer) => {
      outLen += b.length;
      if (outLen > maxBuffer) kill('maxBuffer');
      else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      errLen += b.length;
      if (errLen <= 64 * 1024) err.push(b);
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (e: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          new GitError(scrub(`${label} failed (${e.code ?? e.message})`, secrets), null, false),
        ),
      ),
    );
    child.on('close', (code) =>
      done(() => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (!why && code !== null && ok.includes(code))
          return resolve({ stdout, stderr, exitCode: code });
        // Never include stdout: it can hold commit messages or file contents.
        const detail =
          why === 'timeout'
            ? `timed out after ${timeout} ms`
            : why === 'aborted'
              ? 'aborted'
              : why === 'maxBuffer'
                ? 'output too large'
                : code !== null
                  ? `exit ${code}: ${stderr.trim().slice(0, 500)}`
                  : 'killed';
        reject(
          new GitError(
            scrub(`${label} failed (${detail})`, secrets),
            why ? null : code,
            why === 'timeout',
          ),
        );
      }),
    );
    if (opts.input !== undefined) {
      child.stdin.on('error', () => {}); // git may exit before reading everything; 'close' reports it
      child.stdin.end(opts.input);
    }
  });
}
