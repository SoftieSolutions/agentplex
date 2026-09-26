import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeProcessRunner } from '@agentplex/providers';
import { createGitWorkingTree } from '../working-tree/working-tree.js';
import { createGitStatusOperation } from './git-status.js';
import { runGuardedGitProbe, withoutLazyFetch } from './git-probe.js';

/**
 * The two git probes against real repositories that name programs of their
 * own, with real git on the other end.
 *
 * The subject is which programs git decides to start, and that decision is
 * git's: a filter driver selected through attributes, a lazy fetch in a partial
 * clone, a child git in a populated submodule. None of it can be captured as a
 * fixture, because what matters is a side effect of running rather than a line
 * of output. Each program the repository names here appends to a marker file
 * when it runs, so "nothing ran" is a directory with no marker in it.
 *
 * Every case asserts the other direction too, after the guarded reading: the
 * same repository, asked the status the probe used to ask -- no filter names
 * read, submodules asked, lazy fetching on -- does start the program. Without
 * that the absence of a marker could mean the fixture never reached the door at
 * all. The control runs last, because a lazy fetch that succeeded leaves the
 * blob behind and a guarded reading after it would have nothing to refuse.
 *
 * The repositories are built through the same one-shot runner the server uses,
 * because this directory may not start a child any other way. The environment
 * keeps the machine's own git configuration out: the throwaway home the suite
 * runs under has none, and the two variables below keep a system file or an
 * `$XDG_CONFIG_HOME` from supplying one.
 */

const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

/** What sets the repositories up and what the controls run through. */
const plainRunner = createNodeProcessRunner({ environment });
/** What `main` hands the registry and the working-tree reader. */
const probeRunner = createNodeProcessRunner({ environment: withoutLazyFetch(environment) });

/**
 * Who the fixture's commits are by, and permission to clone a submodule from a
 * local path, which git refuses by default since 2.38.1.
 */
const SETUP_CONFIG = [
  '-c',
  'user.name=fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'protocol.file.allow=always',
];

/**
 * `git.status` as it was before any of this: the fsmonitor and hooks pairs and
 * nothing else. The controls run it, through the runner that fetches lazily.
 */
async function unguardedStatus(directory: string): Promise<void> {
  await plainRunner.run({
    file: 'git',
    args: [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '--no-optional-locks',
      '-C',
      directory,
      'status',
      '--porcelain=v2',
      '--branch',
    ],
    timeoutMs: 20_000,
  });
}

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentplex-git-probes-'));
  temporaries.push(root);
  return root;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const outcome = await plainRunner.run({
    file: 'git',
    args: [...SETUP_CONFIG, '-C', directory, ...args],
    timeoutMs: 20_000,
  });
  if (outcome.kind !== 'exited' || outcome.exitCode !== 0) {
    const said = outcome.kind === 'exited' ? outcome.stderr : outcome.problem;
    throw new Error(`git ${args.join(' ')} failed in ${directory}: ${said}`);
  }
  return outcome.stdout;
}

/** A shell script that appends a line to `markers/<name>` and then does `then`. */
function markerScript(root: string, name: string, then: string): string {
  const markers = join(root, 'markers');
  mkdirSync(markers, { recursive: true });
  const script = join(root, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho ran >> '${join(markers, name)}'\n${then}\n`);
  chmodSync(script, 0o755);
  return script;
}

function markersIn(root: string): string[] {
  const markers = join(root, 'markers');
  return existsSync(markers) ? readdirSync(markers) : [];
}

/**
 * An mtime the checkout was not written at, so git's stat information no
 * longer matches the index and it has to read the file's content to decide
 * whether it changed. That read is what runs a clean filter.
 */
function makeStatDirty(...paths: string[]): void {
  const then = new Date('2001-01-01T00:00:00Z');
  for (const path of paths) utimesSync(path, then, then);
}

describe('the git probes in a repository that names programs of its own', () => {
  it('runs no filter driver the repository configures, and still reads it', async () => {
    const root = temporaryRoot();
    const repository = join(root, 'repository');
    await git(root, ['init', '--quiet', '--initial-branch=main', repository]);

    // Selected from both places a repository keeps attributes: the tracked
    // file anyone who clones it gets, and `.git/info/attributes`, which only
    // this checkout has. The second name has a dot in it, which is where a
    // parser that split the key on its first dot would lose it.
    writeFileSync(join(repository, 'tracked.txt'), 'tracked\n');
    writeFileSync(join(repository, 'other.txt'), 'other\n');
    writeFileSync(join(repository, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(repository, '.git', 'info', 'attributes'), 'other.txt filter=a.b\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '--quiet', '-m', 'fixture']);

    // Configured after the commit, so setting the fixture up ran neither. The
    // process driver fails on purpose, which makes git die when it runs one;
    // `required` on the other is what makes a driver that has been emptied
    // fatal unless the probe says otherwise.
    await git(repository, [
      'config',
      'filter.evil.process',
      markerScript(root, 'process', 'exit 1'),
    ]);
    await git(repository, ['config', 'filter.a.b.clean', markerScript(root, 'clean', 'cat')]);
    await git(repository, ['config', 'filter.a.b.required', 'true']);
    makeStatDirty(join(repository, 'tracked.txt'), join(repository, 'other.txt'));

    const trees = createGitWorkingTree({ runner: probeRunner });
    expect(await trees.branch(repository)).toBe('main');
    expect(await trees.uncommitted(repository)).not.toBeNull();
    expect(markersIn(root)).toEqual([]);

    makeStatDirty(join(repository, 'tracked.txt'), join(repository, 'other.txt'));
    await unguardedStatus(repository);
    expect(markersIn(root)).not.toEqual([]);
  });

  it('starts no lazy fetch in a partial clone, and says it could not read it', async () => {
    const root = temporaryRoot();
    const origin = join(root, 'origin');
    const clone = join(root, 'clone');
    await git(root, ['init', '--quiet', '--initial-branch=main', origin]);
    const lines = Array.from({ length: 200 }, (_, at) => `line ${at}`);
    writeFileSync(join(origin, 'big.txt'), `${lines.join('\n')}\n`);
    await git(origin, ['add', '.']);
    await git(origin, ['commit', '--quiet', '-m', 'fixture']);
    await git(origin, ['config', 'uploadpack.allowFilter', 'true']);

    // A `file://` URL, because a clone from a plain path copies the object
    // store and ignores `--filter`, and a clone with every blob in it has
    // nothing to fetch lazily. `--no-checkout` leaves the index empty, so the
    // file staged below is a rename away from a blob this clone never had.
    await git(root, [
      'clone',
      '--quiet',
      '--no-checkout',
      '--filter=blob:none',
      `file://${origin}`,
      clone,
    ]);
    await git(clone, [
      'config',
      'remote.origin.uploadpack',
      markerScript(root, 'uploadpack', 'exec git upload-pack "$@"'),
    ]);
    writeFileSync(join(clone, 'renamed.txt'), `${lines.slice(0, -1).join('\n')}\n`);
    await git(clone, ['add', 'renamed.txt']);

    const trees = createGitWorkingTree({ runner: probeRunner });
    // Both null: git dies rather than detect a rename it has no blob for, and
    // a reading nobody could take is the one a client draws nothing for.
    expect(await trees.branch(clone)).toBeNull();
    expect(await trees.uncommitted(clone)).toBeNull();
    expect(
      await runGuardedGitProbe(createGitStatusOperation, { directory: clone }, probeRunner),
    ).toMatchObject({ ok: false, refusal: 'failed' });
    expect(markersIn(root)).toEqual([]);

    await unguardedStatus(clone);
    expect(markersIn(root)).toEqual(['uploadpack']);
  });

  it('starts no git in a submodule, whose filters the probe never read', async () => {
    const root = temporaryRoot();
    const library = join(root, 'library');
    const repository = join(root, 'repository');
    await git(root, ['init', '--quiet', '--initial-branch=main', library]);
    writeFileSync(join(library, 'library.txt'), 'library\n');
    writeFileSync(join(library, '.gitattributes'), '* filter=nested\n');
    await git(library, ['add', '.']);
    await git(library, ['commit', '--quiet', '-m', 'fixture']);

    await git(root, ['init', '--quiet', '--initial-branch=main', repository]);
    writeFileSync(join(repository, 'top.txt'), 'top\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '--quiet', '-m', 'fixture']);
    await git(repository, ['submodule', '--quiet', 'add', library, 'library']);
    await git(repository, ['commit', '--quiet', '-m', 'submodule']);

    // The filter is in the submodule's own config, which the probe's read of
    // the outer repository does not see.
    const submodule = join(repository, 'library');
    await git(submodule, ['config', 'filter.nested.clean', markerScript(root, 'nested', 'cat')]);
    makeStatDirty(join(submodule, 'library.txt'));

    const trees = createGitWorkingTree({ runner: probeRunner });
    expect(await trees.branch(repository)).toBe('main');
    expect(await trees.uncommitted(repository)).not.toBeNull();
    expect(markersIn(root)).toEqual([]);

    makeStatDirty(join(submodule, 'library.txt'));
    await unguardedStatus(repository);
    expect(markersIn(root)).toEqual(['nested']);
  });
});
