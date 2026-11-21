import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from '@app/git-graph/git';
import { FixtureRepo } from '@app/git-graph/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RepoBusyError,
  assertNoContents,
  cloneDir,
  ensureClone,
  readCloneGraph,
  redisRepoLock,
  withRepoLock,
  type GitAuth,
  type LockRedis,
  type RepoLock,
} from './repo-cache';

// Keep a developer's global/system git config (url rewrites, signing, …) out of the clone.
const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function memoryLock(): RepoLock & { held: Map<string, string> } {
  const held = new Map<string, string>();
  let n = 0;
  return {
    held,
    async acquire(key) {
      if (held.has(key)) return null;
      const token = `t${++n}`;
      held.set(key, token);
      return token;
    },
    async release(key, token) {
      if (held.get(key) === token) held.delete(key);
    },
  };
}

function cacheRefs(gitDir: string): Record<string, string> {
  const out = execFileSync(
    'git',
    ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'],
    { encoding: 'utf8', env: { ...process.env, ...ISOLATED } },
  );
  return Object.fromEntries(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
}

function fixtureRefs(repo: FixtureRepo): Record<string, string> {
  return Object.fromEntries(repo.branches().map((b) => [b, repo.head(b)]));
}

function gitConfig(gitDir: string): string {
  return execFileSync('git', ['--git-dir', gitDir, 'config', '--local', '--list'], {
    encoding: 'utf8',
  });
}

describe('repo-cache against a local fixture repo', () => {
  let repo: FixtureRepo;
  let cacheDir: string;
  let auth: GitAuth;
  let lock: ReturnType<typeof memoryLock>;
  const target = { githubRepoId: 4242 };
  const opts = () => ({ cacheDir, lock, assertNoContents: true });

  beforeEach(() => {
    repo = FixtureRepo.create('t2c-cache');
    // file:// goes through upload-pack, which ignores --filter unless the "server" allows it.
    repo.run('config', 'uploadpack.allowFilter', 'true');
    repo.commit('one');
    repo.commit('two');
    repo.branch('feat');
    repo.commit('feat work');
    repo.checkout('main');
    cacheDir = mkdtempSync(path.join(tmpdir(), 't2c-cache-'));
    auth = { url: repo.url, env: ISOLATED };
    lock = memoryLock();
  });

  afterEach(() => {
    repo.remove();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('clones commits only, as a non-promisor bare repo with branch refspec', async () => {
    const { gitDir, action } = await ensureClone(target, auth, opts());
    expect(action).toBe('cloned');
    expect(gitDir).toBe(cloneDir(cacheDir, 4242));
    expect(cacheRefs(gitDir)).toEqual(fixtureRefs(repo));
    await assertNoContents(gitDir);

    const config = gitConfig(gitDir);
    expect(config).toContain('remote.origin.promisor=false');
    expect(config).not.toMatch(/partialclonefilter/i);
    expect(config).toContain('remote.origin.fetch=+refs/heads/*:refs/heads/*');
    expect(config).toContain('gc.auto=0');
    expect(lock.held.size).toBe(0);
  });

  it('fetches a new commit, a force-push and a branch delete; never any contents', async () => {
    const { gitDir } = await ensureClone(target, auth, opts());

    repo.commit('three');
    expect((await ensureClone(target, auth, opts())).action).toBe('fetched');
    expect(cacheRefs(gitDir)).toEqual(fixtureRefs(repo));
    await assertNoContents(gitDir);

    // force-push: feat moves back onto main's history
    repo.run('branch', '-f', 'feat', 'main~1');
    await ensureClone(target, auth, opts());
    expect(cacheRefs(gitDir).feat).toBe(repo.head('main~1'));
    await assertNoContents(gitDir);

    repo.run('branch', '-D', 'feat');
    await ensureClone(target, auth, opts());
    expect(cacheRefs(gitDir)).toEqual({ main: repo.head('main') });
    await assertNoContents(gitDir);

    // the fetch re-enabled promisor mode; ensureClone must have locked it down again
    expect(gitConfig(gitDir)).not.toMatch(/partialclonefilter|promisor=true/i);
  });

  it('never lazily fetches a tree into the cache', async () => {
    const { gitDir } = await ensureClone(target, auth, opts());
    await expect(
      runGit(['--git-dir', gitDir, 'cat-file', '-p', 'main^{tree}'], { env: ISOLATED }),
    ).rejects.toThrow();
    await assertNoContents(gitDir);
  });

  it('deletes a corrupt clone and clones again', async () => {
    const { gitDir } = await ensureClone(target, auth, opts());
    rmSync(path.join(gitDir, 'HEAD'));
    rmSync(path.join(gitDir, 'refs'), { recursive: true, force: true });
    const again = await ensureClone(target, auth, opts());
    expect(again.action).toBe('recloned');
    expect(cacheRefs(gitDir)).toEqual(fixtureRefs(repo));
    await assertNoContents(gitDir);
  });

  it('assertNoContents throws on a clone with trees and blobs', async () => {
    const full = path.join(cacheDir, 'full.git');
    execFileSync('git', ['clone', '-q', '--bare', repo.url, full], {
      env: { ...process.env, ...ISOLATED },
    });
    await expect(assertNoContents(full)).rejects.toThrow(/holds contents/);
  });

  it('a failed clone leaves no directory behind and no token in the error', async () => {
    const token = 'ghs_t2cSecretToken123';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const err = await ensureClone(
      target,
      {
        url: `file://${cacheDir}/does-not-exist`,
        env: {
          ...ISOLATED,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: header,
        },
      },
      opts(),
    ).then(
      () => new Error('expected the clone to fail'),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^\[github_error\] git clone failed/);
    expect(err.message).not.toMatch(/x-access-token|AUTHORIZATION|ghs_/i);
    expect(existsSync(cloneDir(cacheDir, 4242))).toBe(false);
  });

  it('readCloneGraph reads every commit and reports heads the clone lacks', async () => {
    await ensureClone(target, auth, opts());
    const missingSha = 'f'.repeat(40);
    const g = await readCloneGraph(target, [repo.head('main'), repo.head('feat'), missingSha], {
      cacheDir,
      lock,
    });
    expect(g.commits.map((c) => c.sha).sort()).toEqual(
      repo.run('rev-list', '--all').split('\n').sort(),
    );
    expect(g.truncated).toBe(false);
    expect([...g.missing]).toEqual([missingSha]);
    await assertNoContents(cloneDir(cacheDir, 4242));
  });

  it('lock: two concurrent syncs of one repo → one runs, the other is busy', async () => {
    const results = await Promise.allSettled([
      ensureClone(target, auth, opts()),
      ensureClone(target, auth, opts()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RepoBusyError);
    expect(lock.held.size).toBe(0);
  });

  it('lock: a waiting sync runs once the holder releases', async () => {
    let release!: () => void;
    const holding = withRepoLock(lock, 4242, () => new Promise<void>((r) => (release = r)));
    const waiting = ensureClone(target, auth, { ...opts(), lockWaitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await holding;
    await expect(waiting).resolves.toMatchObject({ action: 'cloned' });
  });
});

describe('redisRepoLock', () => {
  function fakeRedis(): LockRedis & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      async set(key, value, _px, _ttl, _nx) {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      async eval(_script, _n, key, token) {
        if (store.get(key!) === token) store.delete(key!);
        return 1;
      },
    };
  }

  it('uses SET NX PX and only releases its own token', async () => {
    const redis = fakeRedis();
    const lock = redisRepoLock(redis);
    const a = await lock.acquire('k', 600_000);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await lock.acquire('k', 600_000)).toBeNull();
    await lock.release('k', 'not-mine');
    expect(redis.store.has('k')).toBe(true);
    await lock.release('k', a!);
    expect(redis.store.has('k')).toBe(false);
  });
});
