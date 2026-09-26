import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { runOperation } from '@agentplex/providers';
import {
  FILTER_NAMES_NEUTRALISED,
  filterNameSchema,
  gitFilterNamesOperation,
} from './git-filter-names.js';

/**
 * The fixtures are captured `git config --null --show-scope --get-regexp
 * '^filter\.'` output, taken on git 2.39.5 (bookworm, the image's git) and
 * byte for byte the same on git 2.50.1:
 *
 * - `none`: a fresh repository with no global config. git prints nothing and
 *   exits 1, which is how `--get-regexp` says it matched no key.
 * - `one`: one repository filter with a `clean` and a `process` key.
 * - `several`: a user's global `lfs` beside the repository's own filters: one
 *   plain, one whose name has a dot in it and a `required` key written with no
 *   value, one reached through an `[include]`, one in `worktree` scope, and a
 *   `[filter] x = y` key with no subsection at all.
 * - `equals`: a repository filter whose name has `=` in it, which a config
 *   file allows and a `-c` argument cannot carry.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const NONE = fixture('git-config-filters-none.txt');
const ONE = fixture('git-config-filters-one.txt');
const SEVERAL = fixture('git-config-filters-several.txt');
const EQUALS = fixture('git-config-filters-equals.txt');

const DIRECTORY = '/volumes/work/project';
const COMMAND_LINE = `git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks -C ${DIRECTORY} config --null --show-scope --get-regexp ^filter\\.`;

function answering(outcome: ReturnType<typeof printed>) {
  return createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: outcome } });
}

describe('git.filter-names', () => {
  it('reads nothing to switch off when git matched no key', async () => {
    // Exit 1 with nothing printed is `--get-regexp` finding nothing, which is
    // the common case and not a fault.
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering({ kind: 'exited', exitCode: 1, stdout: NONE, stderr: '' }),
    );

    expect(outcome).toEqual({ ok: true, result: [] });
  });

  it('reads the one filter a repository configures, once for all its keys', async () => {
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed(ONE)),
    );

    expect(outcome).toEqual({ ok: true, result: ['evil'] });
  });

  it('reads the repository filters and leaves the user own alone', async () => {
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed(SEVERAL)),
    );

    // `lfs` is in global scope: the operator configured it for every
    // repository, and switching it off would read an LFS checkout's pointer
    // files as changed. `a.b` keeps its dot. The included file carries the
    // scope of the file that included it, so `included` is the repository's.
    // `[filter] x = y` names no driver, so there is nothing to switch off.
    expect(outcome).toEqual({ ok: true, result: ['evil', 'a.b', 'included', 'wt'] });
  });

  it('refuses a repository filter whose name a -c argument cannot carry', async () => {
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed(EQUALS)),
    );

    // `-c filter.a=b.clean=` is the key `filter.a` set to `b.clean=`: git
    // splits at the first `=`, so the filter would stay on.
    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
    if (!outcome.ok) expect(outcome.problem).toContain(DIRECTORY);
  });

  it('treats a scope it does not know as the repository own', async () => {
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed('submodule\0filter.odd.clean\ncat\0command\0filter.mine.clean\ncat\0')),
    );

    // `command` is `-c` and `GIT_CONFIG_PARAMETERS`: the operator's, like
    // `global`. Anything git might print that is not one of those three is
    // switched off, which costs a filter at worst and never runs one.
    expect(outcome).toEqual({ ok: true, result: ['odd'] });
  });

  it('refuses more filters than an argv can carry', async () => {
    const many = Array.from(
      { length: FILTER_NAMES_NEUTRALISED + 1 },
      (_, at) => `local\0filter.f${at}.clean\ncat\0`,
    ).join('');

    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed(many)),
    );

    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
  });

  it('refuses a record with no key after its scope', async () => {
    const outcome = await runOperation(
      gitFilterNamesOperation,
      { directory: DIRECTORY },
      answering(printed('local\0')),
    );

    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
  });

  it('refuses anything other than an answer or an empty match', async () => {
    // Exit 1 with something printed is not `--get-regexp` finding nothing, and
    // 3 is a config file git could not parse -- a repository that the probe
    // itself would then refuse to read.
    for (const outcome of [
      { kind: 'exited' as const, exitCode: 1, stdout: ONE, stderr: '' },
      refused(3, 'fatal: bad config line 1 in file .git/config'),
      refused(128, `fatal: cannot change to '${DIRECTORY}': No such file or directory`),
    ]) {
      expect(
        await runOperation(gitFilterNamesOperation, { directory: DIRECTORY }, answering(outcome)),
      ).toMatchObject({ ok: false, refusal: 'failed' });
    }
  });

  it('builds the same prefix the probes build, and asks git for NUL-separated scopes', async () => {
    const runner = answering(refused(1, ''));
    await runOperation(gitFilterNamesOperation, { directory: DIRECTORY }, runner);

    expect(runner.requests).toEqual([
      {
        file: 'git',
        args: [
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
        timeoutMs: gitFilterNamesOperation.timeoutMs,
      },
    ]);
  });

  it('refuses a directory that is not absolute without running anything', async () => {
    const runner = answering(refused(1, ''));
    expect(
      await runOperation(gitFilterNamesOperation, { directory: 'project' }, runner),
    ).toMatchObject({ ok: false, refusal: 'invalid-request' });
    expect(runner.requests).toEqual([]);
  });
});

describe('a filter name', () => {
  it('is anything a -c argument can carry', () => {
    for (const name of ['lfs', 'a.b', 'Evil', 'with space', 'x'.repeat(256)]) {
      expect(filterNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('is never a name that would end the key early or not reach git whole', () => {
    // A key ends at the first `=`, a record at a newline in git's own output,
    // and an argv element at a NUL. The last two cannot come out of the parser,
    // which splits on both, so they are written here by hand.
    for (const name of ['a=b', 'a\nb', 'a\0b', '', 'x'.repeat(257)]) {
      expect(filterNameSchema.safeParse(name).success).toBe(false);
    }
  });
});
