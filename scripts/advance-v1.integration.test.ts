import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseVersionsManifest,
  serializeVersionsManifest,
  updateVersionsManifest,
  type VersionsManifest,
} from '@agentplex/release';

/**
 * `advance-v1.sh`, run against a real bare repository standing in for GitHub.
 *
 * The subject is a sequence of pushes to a branch several release jobs write at
 * once, so the only honest fixture is real git on both ends: a bare `origin`,
 * and a clone in the state the release job leaves its checkout in -- the tagged
 * commit present, `master` and `v1` wherever the remote has them. The manifest
 * writer is the real `versions-manifest.ts` too, which is why `pnpm build` has
 * to have run: it imports `@agentplex/release` from its `dist`.
 */

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDirectory, 'advance-v1.sh');

/**
 * Who the fixture's own commits are by. The script sets its own identity, and
 * the throwaway home the suite runs under has no global config, so a commit
 * made here without these would fail on an unknown author.
 */
const identity = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Repositories {
  readonly root: string;
  /** The bare repository standing in for GitHub. */
  readonly origin: string;
  /** The release job's checkout, which the script runs in. */
  readonly work: string;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function repositories(): Repositories {
  const root = mkdtempSync(join(tmpdir(), 'agentplex-advance-v1-'));
  temporaries.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '--quiet', '--bare', '--initial-branch=master', origin]);
  git(root, ['init', '--quiet', '--initial-branch=master', work]);
  git(work, ['remote', 'add', 'origin', origin]);
  return { root, origin, work };
}

/**
 * A commit on the checkout's current branch, carrying `install.sh` with the
 * given contents -- the file whose blob on `v1` says whose tree the branch has.
 */
function commit(repos: Repositories, installer: string): string {
  writeFileSync(join(repos.work, 'install.sh'), `${installer}\n`);
  git(repos.work, ['add', 'install.sh']);
  git(repos.work, ['commit', '--quiet', '--message', installer]);
  return git(repos.work, ['rev-parse', 'HEAD']);
}

function commitOnMaster(repos: Repositories, installer: string): string {
  const sha = commit(repos, installer);
  git(repos.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/master']);
  return sha;
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function advance(
  repos: Repositories,
  component: string,
  version: string,
  protocol: string,
  sha: string,
): Run {
  const result = spawnSync('bash', [script, component, version, protocol, sha, 'origin'], {
    cwd: repos.work,
    encoding: 'utf8',
    // No identity here: the script has to bring its own, as it does on a
    // runner whose checkout has no `user.name`.
    env: { ...process.env, ADVANCE_V1_BACKOFF_SECONDS: '0' },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function advanced(
  repos: Repositories,
  component: string,
  version: string,
  protocol: string,
  sha: string,
): Run {
  const run = advance(repos, component, version, protocol, sha);
  if (run.status !== 0) throw new Error(`advance-v1.sh exited ${run.status}: ${run.stderr}`);
  return run;
}

function manifestOnV1(repos: Repositories): VersionsManifest {
  return parseVersionsManifest('v1', git(repos.origin, ['show', 'refs/heads/v1:versions.json']));
}

function installerOnV1(repos: Repositories): string {
  return git(repos.origin, ['show', 'refs/heads/v1:install.sh']);
}

function trailerOnV1(repos: Repositories): string {
  return git(repos.origin, [
    'log',
    '-1',
    '--format=%(trailers:key=Released-From,valueonly)',
    'refs/heads/v1',
  ]);
}

describe('advance-v1.sh', () => {
  it('creates the branch from the first release, with its tree and a manifest', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');

    advanced(repos, 'hub', '1.0.0', '3', first);

    expect(installerOnV1(repos)).toBe('first');
    expect(manifestOnV1(repos)).toEqual({ hub: { current: '1.0.0', releases: { '1.0.0': 3 } } });
    expect(trailerOnV1(repos)).toBe(first);
  });

  it('keeps both of two sequential releases, and moves the tree to the newer one', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');
    const second = commitOnMaster(repos, 'second');
    const head = git(repos.work, ['rev-parse', 'HEAD']);

    advanced(repos, 'hub', '1.0.0', '3', first);
    advanced(repos, 'cli', '1.1.0', '3', second);

    expect(manifestOnV1(repos)).toEqual({
      hub: { current: '1.0.0', releases: { '1.0.0': 3 } },
      cli: { current: '1.1.0', releases: { '1.1.0': 3 } },
    });
    expect(installerOnV1(repos)).toBe('second');
    expect(trailerOnV1(repos)).toBe(second);
    // Each commit sits on the one before it: no push was forced.
    expect(git(repos.origin, ['rev-list', '--count', 'refs/heads/v1'])).toBe('3');

    // The tree the script ran in is where it was: nothing checked out, no
    // branch made, nothing staged.
    expect(git(repos.work, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repos.work, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/master');
    expect(git(repos.work, ['status', '--porcelain'])).toBe('');
    expect(git(repos.work, ['branch', '--list', 'v1'])).toBe('');
  });

  /**
   * Two release jobs that both fetched `v1` before either pushed. The loser is
   * simulated inside `origin`: a pre-receive hook that, the first time it runs,
   * lands a competing release on `v1` and lets the push go on, so the push is
   * refused for the reason a real race refuses it -- the ref moved after the
   * pusher read it.
   *
   * The hook unsets the quarantine variables first. Git runs pre-receive with
   * the incoming objects in a quarantine directory, and a hook that writes
   * objects through that environment writes them where they are discarded when
   * the push is refused.
   */
  it('rebuilds on the new head and retries when another release lands first', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');
    const second = commitOnMaster(repos, 'second');
    advanced(repos, 'hub', '1.0.0', '3', first);

    const competing = join(repos.root, 'competing.json');
    writeFileSync(
      competing,
      serializeVersionsManifest(
        updateVersionsManifest(manifestOnV1(repos), 'server', { version: '1.2.0', protocol: 3 }),
      ),
    );
    const marker = join(repos.root, 'raced');
    const hook = join(repos.origin, 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'set -eu',
        `[ -e '${marker}' ] && exit 0`,
        `: > '${marker}'`,
        'unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
        ...Object.entries(identity).map(([name, value]) => `export ${name}='${value}'`),
        `GIT_INDEX_FILE='${join(repos.root, 'race-index')}'`,
        'export GIT_INDEX_FILE',
        'old=$(git rev-parse refs/heads/v1)',
        'git read-tree "$old"',
        `blob=$(git hash-object -w '${competing}')`,
        'git update-index --add --cacheinfo "100644,$blob,versions.json"',
        'tree=$(git write-tree)',
        'new=$(git commit-tree "$tree" -p "$old" -m "server 1.2.0: landed first")',
        'git update-ref refs/heads/v1 "$new" "$old"',
        '',
      ].join('\n'),
    );
    chmodSync(hook, 0o755);

    advanced(repos, 'cli', '1.1.0', '3', second);

    expect(existsSync(marker)).toBe(true);
    expect(manifestOnV1(repos)).toEqual({
      hub: { current: '1.0.0', releases: { '1.0.0': 3 } },
      server: { current: '1.2.0', releases: { '1.2.0': 3 } },
      cli: { current: '1.1.0', releases: { '1.1.0': 3 } },
    });
    expect(installerOnV1(repos)).toBe('second');
    expect(git(repos.origin, ['log', '-1', '--format=%s', 'refs/heads/v1^'])).toBe(
      'server 1.2.0: landed first',
    );
  });

  it('records a tag cut from a commit not on master, and leaves the tree alone', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');
    advanced(repos, 'hub', '1.0.0', '3', first);

    git(repos.work, ['checkout', '--quiet', '-b', 'side']);
    const side = commit(repos, 'side');
    git(repos.work, ['checkout', '--quiet', 'master']);

    advanced(repos, 'hub', '1.0.1', '3', side);

    expect(manifestOnV1(repos)).toEqual({
      hub: { current: '1.0.1', releases: { '1.0.0': 3, '1.0.1': 3 } },
    });
    expect(installerOnV1(repos)).toBe('first');
    expect(trailerOnV1(repos)).toBe('');
  });

  it('records a tag cut from a commit older than the tree it has, and leaves the tree alone', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');
    const second = commitOnMaster(repos, 'second');
    advanced(repos, 'hub', '1.0.0', '3', second);

    advanced(repos, 'server', '1.0.0', '3', first);

    expect(manifestOnV1(repos)).toEqual({
      hub: { current: '1.0.0', releases: { '1.0.0': 3 } },
      server: { current: '1.0.0', releases: { '1.0.0': 3 } },
    });
    expect(installerOnV1(repos)).toBe('second');
  });

  /**
   * The source is searched for rather than read off the head, because a
   * prerelease commit carries none: reading the head alone would take the
   * commit after a release candidate for a branch that never recorded a
   * source, and let an older tag move the tree backwards.
   */
  it('records a prerelease without moving the tree, and still guards on the source before it', () => {
    const repos = repositories();
    const older = commitOnMaster(repos, 'older');
    const released = commitOnMaster(repos, 'released');
    const candidate = commitOnMaster(repos, 'candidate');
    advanced(repos, 'hub', '1.0.0', '3', released);

    advanced(repos, 'hub', '1.1.0-rc1', '3', candidate);

    expect(manifestOnV1(repos)).toEqual({
      hub: { current: '1.0.0', releases: { '1.0.0': 3, '1.1.0-rc1': 3 } },
    });
    expect(installerOnV1(repos)).toBe('released');
    expect(trailerOnV1(repos)).toBe('');

    advanced(repos, 'cli', '1.0.0', '3', older);

    expect(installerOnV1(repos)).toBe('released');
  });

  /**
   * The branch as the job before this one left it: the released commit pushed
   * as it was, with no trailer anywhere in its history. There is no recorded
   * source to descend from, so the one guard left is `master`.
   */
  it('moves a branch that has no recorded source to any released commit on master', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');
    git(repos.work, ['push', '--quiet', 'origin', `${first}:refs/heads/v1`]);
    const second = commitOnMaster(repos, 'second');

    advanced(repos, 'cli', '1.1.0', '3', second);

    expect(installerOnV1(repos)).toBe('second');
    expect(trailerOnV1(repos)).toBe(second);
    expect(git(repos.origin, ['rev-parse', 'refs/heads/v1^'])).toBe(first);
  });

  it('refuses a call without the four values and a remote', () => {
    const repos = repositories();
    const first = commitOnMaster(repos, 'first');

    const run = spawnSync('bash', [script, 'hub', '1.0.0', '3', first], {
      cwd: repos.work,
      encoding: 'utf8',
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('usage');
    expect(git(repos.origin, ['branch', '--list', 'v1'])).toBe('');
  });
});
