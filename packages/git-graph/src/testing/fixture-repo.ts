// Builds small real git repos for tests (T1 oracle suite; reused by T2c and T3a). Test-only, synchronous.
// Global/system git config is ignored so a developer's settings (signing, hooks, default branch) can't leak in.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export class FixtureRepo {
  /** seconds since epoch; every commit is one minute after the previous one */
  private clock = 1_700_000_000;

  private constructor(readonly dir: string) {}

  /** A non-bare repo whose first branch is `defaultBranch`. */
  static create(name = 'fixture', defaultBranch = 'main'): FixtureRepo {
    const dir = mkdtempSync(join(tmpdir(), `git-graph-${name.replace(/[^\w-]/g, '_')}-`));
    const repo = new FixtureRepo(dir);
    repo.git('init', '-q', '-b', defaultBranch);
    return repo;
  }

  get gitDir(): string {
    return join(this.dir, '.git');
  }

  /** file:// URL, usable as a clone "remote" */
  get url(): string {
    return `file://${this.dir}`;
  }

  git(...args: string[]): string {
    return this.gitResult(args).stdout.trim();
  }

  /** Run git; non-zero exit is returned, not thrown. */
  gitResult(args: string[]): { stdout: string; status: number } {
    try {
      const stdout = execFileSync('git', args, {
        cwd: this.dir,
        env: this.env(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, status: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      if (typeof err.status === 'number' && err.status !== 0 && err.status < 128) {
        return { stdout: err.stdout ?? '', status: err.status };
      }
      throw e;
    }
  }

  /** Like `git()` but throws on a non-zero exit. */
  run(...args: string[]): string {
    const r = this.gitResult(args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}`);
    return r.stdout.trim();
  }

  /** Write `files` (path → content; default `<label>.txt`) and commit on the current branch. */
  commit(label: string, files?: Record<string, string>): string {
    for (const [path, content] of Object.entries(
      files ?? { [`${slug(label)}.txt`]: `${label}\n` },
    )) {
      const full = join(this.dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    this.run('add', '-A');
    this.tick();
    this.run('commit', '-q', '-m', label);
    return this.head();
  }

  /** Create `name` at `at` (default: HEAD) and check it out. */
  branch(name: string, at?: string): void {
    this.run('checkout', '-q', '-b', name, ...(at ? [at] : []));
  }

  checkout(rev: string): void {
    this.run('checkout', '-q', rev);
  }

  /** `git merge --no-ff` of `rev` into the current branch. */
  merge(rev: string, label = `Merge ${rev}`): string {
    this.tick();
    this.run('merge', '-q', '--no-ff', '-m', label, rev);
    return this.head();
  }

  /** `git merge --squash` + commit: one new commit with all of `rev`'s change. */
  squash(rev: string, label = `Squash ${rev}`): string {
    this.run('merge', '-q', '--squash', rev);
    this.tick();
    this.run('commit', '-q', '-m', label);
    return this.head();
  }

  /** Cherry-pick each commit onto the current branch (a rebase merge). Returns the new SHAs. */
  cherryPick(shas: readonly string[]): string[] {
    return shas.map((sha) => {
      this.tick();
      this.run('cherry-pick', sha);
      return this.head();
    });
  }

  head(rev = 'HEAD'): string {
    return this.run('rev-parse', '--verify', `${rev}^{commit}`);
  }

  branches(): string[] {
    return this.run('for-each-ref', '--format=%(refname:short)', 'refs/heads')
      .split('\n')
      .filter(Boolean);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private tick() {
    this.clock += 60;
  }

  private env(): NodeJS.ProcessEnv {
    const date = `${this.clock} +0000`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    return env;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'file';

/** Parse `git --version`; null when git is missing. */
export function gitVersion(): [number, number, number] | null {
  try {
    const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  } catch {
    return null;
  }
}

export function gitAtLeast(major: number, minor: number): boolean {
  const v = gitVersion();
  return !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
}
