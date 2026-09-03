import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from './fake-process-runner.js';
import { gitStatusOperation } from './git-status.js';
import { runOperation } from './operation.js';

/**
 * The fixtures are captured `git status --porcelain=v2 --branch` output, taken
 * from this repository's own checkout while AGX-21 was being written: clean on
 * a branch with an upstream, then the same branch with two modified files and
 * an untracked directory, then the same tree with HEAD detached. The failure
 * fixture is git's own stderr from running the same command in a directory that
 * is not a repository, which it answers with exit 128.
 *
 * Written from memory they would prove nothing: porcelain v2 is exactly the
 * kind of format where the detail that bites — that an untracked directory is
 * reported as one entry, that `branch.upstream` is simply absent rather than
 * empty when there is none — is a detail nobody remembers correctly.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const CLEAN = fixture('git-status-clean.txt');
const AHEAD = fixture('git-status-ahead.txt');
const DIRTY = fixture('git-status-dirty.txt');
const DETACHED = fixture('git-status-detached.txt');
const NOT_A_REPOSITORY = fixture('git-not-a-repository.txt');

const DIRECTORY = '/Users/dev/Code/agentplex';

/**
 * The argv this operation must build, spelled out rather than derived from the
 * operation itself: a test that asks the code what it does and then agrees
 * checks nothing. The directory is here, in the arguments, and this line is
 * what fails if it ever moves to a spawn cwd.
 */
const COMMAND_LINE = `git --no-optional-locks -C ${DIRECTORY} status --porcelain=v2 --branch`;

function runner(stdout: string) {
  return createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(stdout) } });
}

describe('git.status', () => {
  it('reads the branch, its upstream and a clean tree out of real git output', async () => {
    const outcome = await runOperation(gitStatusOperation, { directory: DIRECTORY }, runner(CLEAN));

    expect(outcome).toEqual({
      ok: true,
      result: {
        branch: 'agx-21-operation-registry',
        upstream: 'origin/agx-20-terminal-cap',
        ahead: 0,
        behind: 0,
        changes: 0,
      },
    });
  });

  it('reads how far the branch has moved from its upstream', async () => {
    // Captured from this branch one commit after the registry landed, so the
    // `+1 -0` below is a state a real repository was actually in rather than a
    // shape written to make the parser look right.
    const outcome = await runOperation(gitStatusOperation, { directory: DIRECTORY }, runner(AHEAD));

    expect(outcome).toMatchObject({ ok: true, result: { ahead: 1, behind: 0 } });
  });

  it('counts the entries git reports for a dirty tree', async () => {
    const outcome = await runOperation(gitStatusOperation, { directory: DIRECTORY }, runner(DIRTY));

    // Three, not four: git collapses the untracked directory into one entry,
    // and this is the count of what git said rather than a claim about how many
    // files are in there. Over-claiming here would put a wrong number on a
    // session in the client, which is worse than a conservative one.
    expect(outcome).toEqual({
      ok: true,
      result: {
        branch: 'agx-21-operation-registry',
        upstream: 'origin/agx-20-terminal-cap',
        ahead: 0,
        behind: 0,
        changes: 3,
      },
    });
  });

  it('reports a detached head as no branch and no upstream', async () => {
    const outcome = await runOperation(
      gitStatusOperation,
      { directory: DIRECTORY },
      runner(DETACHED),
    );

    // `(detached)` is a literal git prints, not a branch anyone can push, so it
    // must not be reported as one. There is no `branch.upstream` line at all in
    // this state, which is the case a parser that read fields positionally
    // would get wrong.
    expect(outcome).toEqual({
      ok: true,
      result: { branch: null, upstream: null, ahead: 0, behind: 0, changes: 3 },
    });
  });

  it('puts the directory in the argv and never in the spawn', async () => {
    const fake = runner(CLEAN);
    await runOperation(gitStatusOperation, { directory: DIRECTORY }, fake);

    const [request] = fake.requests;
    expect(request).toEqual({
      file: 'git',
      args: ['--no-optional-locks', '-C', DIRECTORY, 'status', '--porcelain=v2', '--branch'],
      timeoutMs: gitStatusOperation.timeoutMs,
    });
    // The point of the assertion above, stated as itself: a directory is
    // something git parses out of its own arguments, never state the kernel
    // applies to the child.
    expect(Object.keys(request ?? {}).sort()).toEqual(['args', 'file', 'timeoutMs']);
  });

  it('refuses a directory that is not absolute without running anything', async () => {
    const fake = runner(CLEAN);
    const outcome = await runOperation(gitStatusOperation, { directory: 'Code/agentplex' }, fake);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ refusal: 'invalid-request' });
    // Nothing was started. A request that does not parse cannot contribute an
    // argv element, because the builder is never reached.
    expect(fake.requests).toEqual([]);
  });

  it('refuses a directory carrying a null byte', async () => {
    const fake = runner(CLEAN);
    const outcome = await runOperation(gitStatusOperation, { directory: '/tmp/a\0/etc' }, fake);

    // A NUL truncates the path at the syscall, so what gets opened is a prefix
    // of what was checked.
    expect(outcome).toMatchObject({ ok: false, refusal: 'invalid-request' });
    expect(fake.requests).toEqual([]);
  });

  it('refuses a request that is not a request at all', async () => {
    const fake = runner(CLEAN);

    for (const request of [null, 'git status', { directory: 7 }, {}]) {
      expect(await runOperation(gitStatusOperation, request, fake)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it('passes git own refusal through in git own words', async () => {
    const fake = createFakeProcessRunner({
      outcomes: { [COMMAND_LINE]: refused(128, NOT_A_REPOSITORY) },
    });

    const outcome = await runOperation(gitStatusOperation, { directory: DIRECTORY }, fake);

    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem).toContain('not a git repository');
      expect(outcome.problem).toContain(DIRECTORY);
    }
  });

  it('says the machine could not run it when git is not installed', async () => {
    // The fake's default: a program the machine has never heard of. A server in
    // a container without git must say so rather than report a session as
    // having no branch.
    const outcome = await runOperation(
      gitStatusOperation,
      { directory: DIRECTORY },
      createFakeProcessRunner(),
    );

    expect(outcome).toMatchObject({ ok: false, refusal: 'unavailable' });
  });

  it('refuses output that carries no branch header', async () => {
    // An empty answer is not a clean repository: something else ran, or ran
    // differently. Reporting "no changes, no branch" would be a claim about a
    // directory nobody looked at.
    const outcome = await runOperation(gitStatusOperation, { directory: DIRECTORY }, runner(''));

    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
  });
});
