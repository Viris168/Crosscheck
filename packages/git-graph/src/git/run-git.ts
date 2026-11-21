// Run git without a shell. Every call disables prompts and lazy fetches, and errors are scrubbed of
// tokens before they can reach a log line.
import { execFile } from 'node:child_process';

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

export function buildGitEnv(extra: RunGitOptions['env'] = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  // VERIFY: GIT_NO_LAZY_FETCH needs git >= 2.44; older git ignores it (cache relies on promisor=false too).
  env.GIT_NO_LAZY_FETCH = '1';
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
  const env = buildGitEnv(opts.env);
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

  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        env,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const exitCode = typeof e.code === 'number' ? e.code : null;
        if (exitCode !== null && ok.includes(exitCode))
          return resolve({ stdout, stderr, exitCode });
        const timedOut = Boolean(e.killed) && exitCode === null;
        // Never include stdout: it can hold commit messages or file contents.
        const detail = timedOut
          ? `timed out after ${timeout} ms`
          : exitCode !== null
            ? `exit ${exitCode}: ${String(stderr).trim().slice(0, 500)}`
            : String(e.code ?? e.message);
        reject(new GitError(scrub(`${label} failed (${detail})`, secrets), exitCode, timedOut));
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}); // git may exit before reading everything; the callback reports it
      child.stdin?.end(opts.input);
    }
  });
}
