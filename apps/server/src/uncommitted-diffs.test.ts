import { describe, expect, it } from 'vitest';
import type { UncommittedDiff } from '@agentplex/protocol';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { createFakeUncommittedDiffs } from './fake-uncommitted-diffs.js';
import {
  createGitUncommittedDiffs,
  readUncommittedDiffs,
  DIRECTORIES_PER_REPORT,
} from './uncommitted-diffs.js';

const DIRECTORY = '/volumes/work/project';
const COMMAND_LINE = `git --no-optional-locks -C ${DIRECTORY} diff-index -M --numstat -z HEAD --`;

const ONE_FILE: UncommittedDiff = {
  files: 1,
  added: 3,
  removed: 1,
  entries: [{ path: 'src/auth/refresh.ts', added: 3, removed: 1 }],
};

describe('the real reader', () => {
  it('answers with what git counted', async () => {
    const diffs = createGitUncommittedDiffs({
      runner: createFakeProcessRunner({
        outcomes: { [COMMAND_LINE]: printed('3\t1\tsrc/auth/refresh.ts\0') },
      }),
    });

    expect(await diffs.read(DIRECTORY)).toEqual(ONE_FILE);
  });

  it('answers null for every way a directory can fail to have an answer', async () => {
    // One shape for all of them, on purpose. A directory that is not a
    // repository, a repository with no commits, a path that is gone, a machine
    // with no git, and a request that does not parse are five different
    // problems and one fact about the screen: nobody read this, so draw
    // nothing. A zero in any of these cases would say a person has nothing
    // outstanding.
    const notARepository = createGitUncommittedDiffs({
      runner: createFakeProcessRunner({
        outcomes: {
          [COMMAND_LINE]: refused(128, 'fatal: not a git repository (or any of the parent'),
        },
      }),
    });
    expect(await notARepository.read(DIRECTORY)).toBeNull();

    const noGit = createGitUncommittedDiffs({ runner: createFakeProcessRunner() });
    expect(await noGit.read(DIRECTORY)).toBeNull();

    // A relative path never reaches a child: `git.diff` refuses the request and
    // the builder is never called.
    const runner = createFakeProcessRunner();
    const unparseable = createGitUncommittedDiffs({ runner });
    expect(await unparseable.read('project')).toBeNull();
    expect(runner.requests).toEqual([]);
  });
});

describe('one diffstat per directory in a report', () => {
  it('asks once for a directory several sessions share', async () => {
    const diffs = createFakeUncommittedDiffs({ [DIRECTORY]: ONE_FILE });

    const found = await readUncommittedDiffs([DIRECTORY, DIRECTORY, DIRECTORY], diffs);

    // `git diff-index` answers for the whole repository whichever directory
    // inside it was named, so three sessions in one checkout are one child and
    // not three.
    expect(diffs.asked).toEqual([DIRECTORY]);
    expect(found.get(DIRECTORY)).toEqual(ONE_FILE);
  });

  it('leaves out a directory that could not be read, and keeps the ones that could', async () => {
    const diffs = createFakeUncommittedDiffs({ [DIRECTORY]: ONE_FILE });

    const found = await readUncommittedDiffs([DIRECTORY, '/volumes/work/not-a-repo'], diffs);

    // A directory that answered costs nothing to one that did not. The absent
    // key is what becomes `null` on a descriptor.
    expect([...found.keys()]).toEqual([DIRECTORY]);
  });

  it('stops asking after a bounded number of directories in one scan', async () => {
    const diffs = createFakeUncommittedDiffs();
    const many = Array.from({ length: DIRECTORIES_PER_REPORT + 4 }, (_, at) => `/volumes/w-${at}`);

    await readUncommittedDiffs(many, diffs);

    // A report is sent on every scan, and a scan can be triggered by an agent
    // writing a line. What it costs has to be bounded by something other than
    // how many checkouts a store happens to hold; the ones past the cap report
    // that nobody looked, which is true.
    expect(diffs.asked).toHaveLength(DIRECTORIES_PER_REPORT);
    expect(diffs.asked).toEqual(many.slice(0, DIRECTORIES_PER_REPORT));
  });

  it('asks nothing when there is nothing to ask about', async () => {
    const diffs = createFakeUncommittedDiffs();

    expect(await readUncommittedDiffs([], diffs)).toEqual(new Map());
    expect(diffs.asked).toEqual([]);
  });
});
