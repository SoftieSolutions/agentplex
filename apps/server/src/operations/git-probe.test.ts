import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { createGitDiffOperation } from './git-diff.js';
import { createGitStatusOperation } from './git-status.js';
import { runGuardedGitProbe, withoutLazyFetch } from './git-probe.js';

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const ONE = fixture('git-config-filters-one.txt');
const SEVERAL = fixture('git-config-filters-several.txt');
const EQUALS = fixture('git-config-filters-equals.txt');
const CLEAN_STATUS = fixture('git-status-clean.txt');

const DIRECTORY = '/volumes/work/project';
const PREFIX = `git -c core.fsmonitor=false -c core.hooksPath=/dev/null`;
const READ = `${PREFIX} --no-optional-locks -C ${DIRECTORY} config --null --show-scope --get-regexp ^filter\\.`;

/** The four `-c` pairs that switch one filter off, spelled out for one name. */
function off(name: string): string {
  return `-c filter.${name}.clean= -c filter.${name}.smudge= -c filter.${name}.process= -c filter.${name}.required=false`;
}

describe('a guarded git probe', () => {
  it('reads the repository filter names first, then switches each one off', async () => {
    const status = `${PREFIX} ${off('evil')} --no-optional-locks -C ${DIRECTORY} status --porcelain=v2 --branch --ignore-submodules=dirty`;
    const runner = createFakeProcessRunner({
      outcomes: { [READ]: printed(ONE), [status]: printed(CLEAN_STATUS) },
    });

    const outcome = await runGuardedGitProbe(
      createGitStatusOperation,
      { directory: DIRECTORY },
      runner,
    );

    expect(outcome).toMatchObject({ ok: true, result: { branch: 'agx-21-operation-registry' } });
    expect(runner.requests.map((request) => request.args)).toEqual([
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '--no-optional-locks',
        '-C',
        DIRECTORY,
        'config',
        '--null',
        '--show-scope',
        '--get-regexp',
        '^filter\\.',
      ],
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'filter.evil.clean=',
        '-c',
        'filter.evil.smudge=',
        '-c',
        'filter.evil.process=',
        '-c',
        'filter.evil.required=false',
        '--no-optional-locks',
        '-C',
        DIRECTORY,
        'status',
        '--porcelain=v2',
        '--branch',
        '--ignore-submodules=dirty',
      ],
    ]);
  });

  it('switches off every repository filter, in the order git listed them', async () => {
    const diff = `${PREFIX} ${off('evil')} ${off('a.b')} ${off('included')} ${off('wt')} --no-optional-locks -C ${DIRECTORY} diff-index --ignore-submodules=dirty -M --numstat -z HEAD --`;
    const runner = createFakeProcessRunner({
      outcomes: { [READ]: printed(SEVERAL), [diff]: printed('') },
    });

    const outcome = await runGuardedGitProbe(
      createGitDiffOperation,
      { directory: DIRECTORY },
      runner,
    );

    // Not `lfs`: the user's global filter stays on, so an LFS checkout reads
    // as its content and not as its pointer files.
    expect(outcome).toEqual({ ok: true, result: { files: 0, added: 0, removed: 0, entries: [] } });
    expect(runner.requests).toHaveLength(2);
  });

  it('runs no probe when a filter could not be switched off', async () => {
    const runner = createFakeProcessRunner({ outcomes: { [READ]: printed(EQUALS) } });

    const outcome = await runGuardedGitProbe(
      createGitStatusOperation,
      { directory: DIRECTORY },
      runner,
    );

    // A probe run with that filter still on would be the program the read
    // exists to keep from running.
    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
    expect(runner.requests).toHaveLength(1);
  });

  it('runs no probe when the names could not be read at all', async () => {
    const notThere = createFakeProcessRunner();
    expect(
      await runGuardedGitProbe(createGitStatusOperation, { directory: DIRECTORY }, notThere),
    ).toMatchObject({ ok: false, refusal: 'unavailable' });
    expect(notThere.requests).toHaveLength(1);

    const gone = createFakeProcessRunner({
      outcomes: { [READ]: refused(128, `fatal: cannot change to '${DIRECTORY}'`) },
    });
    expect(
      await runGuardedGitProbe(createGitDiffOperation, { directory: DIRECTORY }, gone),
    ).toMatchObject({ ok: false, refusal: 'failed' });
    expect(gone.requests).toHaveLength(1);
  });

  it('starts nothing for a request the probe cannot parse', async () => {
    const runner = createFakeProcessRunner();

    for (const request of [undefined, { directory: 'project' }, { directory: DIRECTORY, x: 1 }]) {
      expect(await runGuardedGitProbe(createGitStatusOperation, request, runner)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }

    expect(runner.requests).toEqual([]);
  });
});

describe('an environment without lazy fetching', () => {
  it('sets GIT_NO_LAZY_FETCH and nothing else', () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/agentplex', TZ: undefined };

    expect(withoutLazyFetch(inherited)).toEqual({ ...inherited, GIT_NO_LAZY_FETCH: '1' });
    // The environment the sessions and the pty get is the same object, and it
    // must not have gained the variable.
    expect(inherited).not.toHaveProperty('GIT_NO_LAZY_FETCH');
  });

  it('wins over a value the server inherited', () => {
    expect(withoutLazyFetch({ GIT_NO_LAZY_FETCH: '0' })).toEqual({ GIT_NO_LAZY_FETCH: '1' });
  });
});
