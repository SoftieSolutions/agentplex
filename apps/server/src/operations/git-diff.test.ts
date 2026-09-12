import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { runOperation } from '@agentplex/providers';
import { UNCOMMITTED_FILES_LISTED } from '@agentplex/protocol';
import { gitDiffOperation } from './git-diff.js';

/**
 * Every fixture here is the stdout or the stderr of a real
 * `git --no-optional-locks -C <dir> diff-index -M --numstat -z HEAD --`, run
 * against repositories built for the purpose while AGX-131 was written, and
 * copied in byte for byte.
 *
 * Written from memory they would prove nothing. `-z --numstat` is exactly the
 * kind of format whose detail bites: that a rename is three NUL-terminated
 * fields and not one, that the counts for a binary are `-` and not `0`, that a
 * file name may contain a newline and git does not escape it here, that the
 * last record has a NUL after it and so the split leaves an empty tail. Each of
 * those is in `git-diff-numstat-dirty.txt` because a real git put it there.
 *
 * The dirty tree was: a binary file rewritten, a staged edit, a deleted file, a
 * staged new file whose name contains a newline, another staged new file, an
 * unstaged edit, and a rename. It also had an untracked file, which does not
 * appear in any of this — see `uncommittedDiffSchema` for why untracked work is
 * `git.status`'s number and not this one's.
 *
 * `git-diff-numstat-unrepresentable-path.txt` had to be captured on Linux in a
 * container: macOS refuses to create a file whose name is not valid UTF-8, and
 * the whole point of that fixture is a name that is not.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const CLEAN = fixture('git-diff-numstat-clean.txt');
const DIRTY = fixture('git-diff-numstat-dirty.txt');
const WIDE = fixture('git-diff-numstat-wide.txt');
const UNREPRESENTABLE = fixture('git-diff-numstat-unrepresentable-path.txt');
const NOT_A_REPOSITORY = fixture('git-diff-not-a-repository.txt');
const NO_COMMITS = fixture('git-diff-no-commits.txt');
const NO_SUCH_DIRECTORY = fixture('git-diff-no-such-directory.txt');

const DIRECTORY = '/Users/dev/Code/agentplex';

/**
 * The argv this operation must build, spelled out rather than derived from the
 * operation itself: a test that asks the code what it does and then agrees
 * checks nothing. The directory is here, in the arguments, and this line is
 * what fails if it ever moves to a spawn cwd.
 */
const COMMAND_LINE = `git --no-optional-locks -C ${DIRECTORY} diff-index -M --numstat -z HEAD --`;

function runner(stdout: string) {
  return createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(stdout) } });
}

describe('git.diff', () => {
  it('reports a clean tree as no files and no lines', async () => {
    const outcome = await runOperation(gitDiffOperation, { directory: DIRECTORY }, runner(CLEAN));

    // Empty output is an answer here, unlike a status: a diff with nothing to
    // say prints nothing at all, so this must not be read as unparseable.
    expect(outcome).toEqual({
      ok: true,
      result: { files: 0, added: 0, removed: 0, entries: [] },
    });
  });

  it('reads every record shape out of one real dirty tree', async () => {
    const outcome = await runOperation(gitDiffOperation, { directory: DIRECTORY }, runner(DIRTY));

    expect(outcome).toEqual({
      ok: true,
      result: {
        files: 7,
        // 2 + 0 + 1 + 3 + 3 + 0, and nothing from the binary.
        added: 9,
        removed: 3,
        entries: [
          // A binary is `null` and never `0`: git declined to count it, which
          // is a different fact from counting it and finding nothing.
          { path: 'src/auth/blob.bin', added: null, removed: null },
          { path: 'src/auth/index.ts', added: 2, removed: 1 },
          { path: 'src/auth/legacy.ts', added: 0, removed: 1 },
          // A newline inside a file name, unescaped, which is the whole reason
          // the records are NUL-terminated rather than line-terminated.
          { path: 'src/auth/new\nline.ts', added: 1, removed: 0 },
          { path: 'src/auth/refresh.test.ts', added: 3, removed: 0 },
          { path: 'src/auth/refresh.ts', added: 3, removed: 1 },
          // The rename: three fields, and the destination is the file that is
          // on disk now. `0 0` because `-M` recognised it rather than reporting
          // the old path deleted and the new one added in full.
          { path: 'src/auth/renamed file.ts', added: 0, removed: 0 },
        ],
      },
    });
  });

  it('counts every file but lists only a bounded prefix of them', async () => {
    const outcome = await runOperation(gitDiffOperation, { directory: DIRECTORY }, runner(WIDE));

    // The totals are over all twenty-five files and the rows stop at the cap.
    // A client with fewer rows than files has a list that was cut, which it can
    // see, rather than a count that is quietly wrong.
    expect(outcome).toMatchObject({
      ok: true,
      result: { files: 25, added: 50, removed: 25 },
    });
    expect(outcome.ok && outcome.result.entries).toHaveLength(UNCOMMITTED_FILES_LISTED);
  });

  it('counts a file whose name it cannot represent, and shows no name for it', async () => {
    const outcome = await runOperation(
      gitDiffOperation,
      { directory: DIRECTORY },
      runner(UNREPRESENTABLE),
    );

    // The bytes 0xFF 0xFE are not UTF-8, so the runner's decode already replaced
    // them and the original name is gone. Dropping the row would make the count
    // on screen smaller than the truth; showing the mangled name would put a
    // file nobody can open in front of a user. It costs its name and nothing
    // else.
    expect(outcome).toEqual({
      ok: true,
      result: {
        files: 2,
        added: 3,
        removed: 0,
        entries: [
          { path: null, added: 2, removed: 0 },
          { path: 'src/auth/refresh.ts', added: 1, removed: 0 },
        ],
      },
    });
  });

  it('puts the directory in the argv and never in the spawn', async () => {
    const fake = runner(CLEAN);
    await runOperation(gitDiffOperation, { directory: DIRECTORY }, fake);

    const [request] = fake.requests;
    expect(request).toEqual({
      file: 'git',
      args: [
        '--no-optional-locks',
        '-C',
        DIRECTORY,
        'diff-index',
        '-M',
        '--numstat',
        '-z',
        'HEAD',
        '--',
      ],
      timeoutMs: gitDiffOperation.timeoutMs,
    });
    // The point of the assertion above, stated as itself: a directory is
    // something git parses out of its own arguments, never state the kernel
    // applies to the child.
    expect(Object.keys(request ?? {}).sort()).toEqual(['args', 'file', 'timeoutMs']);
  });

  it('refuses a directory that is not absolute, or carries a null byte, without running anything', async () => {
    const fake = runner(CLEAN);

    for (const directory of ['Code/agentplex', '/tmp/a\0/etc', '']) {
      expect(await runOperation(gitDiffOperation, { directory }, fake)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }
    // Nothing was started. A request that does not parse cannot contribute an
    // argv element, because the builder is never reached.
    expect(fake.requests).toEqual([]);
  });

  it('refuses a request that is not a request at all', async () => {
    const fake = runner(CLEAN);

    for (const request of [
      null,
      'git diff',
      { directory: 7 },
      {},
      { directory: DIRECTORY, x: 1 },
    ]) {
      expect(await runOperation(gitDiffOperation, request, fake)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it('passes git own refusal through in git own words', async () => {
    // Three things a directory can be that are not a fault of this server's,
    // each answered by git with exit 128 and one sentence. `diff-index` is in
    // the argv rather than `diff` precisely so that the first of these is one
    // line: `git diff` answers it with seven kilobytes of usage text.
    const cases = [
      { stderr: NOT_A_REPOSITORY, expected: 'not a git repository' },
      { stderr: NO_COMMITS, expected: "bad revision 'HEAD'" },
      { stderr: NO_SUCH_DIRECTORY, expected: 'No such file or directory' },
    ];

    for (const { stderr, expected } of cases) {
      const fake = createFakeProcessRunner({
        outcomes: { [COMMAND_LINE]: refused(128, stderr) },
      });

      const outcome = await runOperation(gitDiffOperation, { directory: DIRECTORY }, fake);

      expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.problem).toContain(expected);
        expect(outcome.problem).toContain(DIRECTORY);
      }
    }
  });

  it('says the machine could not run it when git is not installed', async () => {
    // The fake's default: a program the machine has never heard of. A server in
    // a container without git must say so rather than report a working tree
    // with nothing outstanding in it.
    const outcome = await runOperation(
      gitDiffOperation,
      { directory: DIRECTORY },
      createFakeProcessRunner(),
    );

    expect(outcome).toMatchObject({ ok: false, refusal: 'unavailable' });
  });

  it('refuses output it cannot read rather than reporting the part it could', async () => {
    // A partial parse is the over-claim this guards. Every one of these is
    // output that does not answer the question, and answering "nothing
    // outstanding" to any of them would be a claim about a directory nobody
    // read.
    const unreadable = [
      'src/auth/refresh.ts\0',
      '1\tsrc/auth/refresh.ts\0',
      'x\ty\tsrc/auth/refresh.ts\0',
      '-\t2\tsrc/auth/refresh.ts\0',
      '1\t0\t\0src/auth/old.ts\0',
      '\0\0',
    ];

    for (const stdout of unreadable) {
      expect(
        await runOperation(gitDiffOperation, { directory: DIRECTORY }, runner(stdout)),
      ).toMatchObject({ ok: false, refusal: 'failed' });
    }
  });
});
