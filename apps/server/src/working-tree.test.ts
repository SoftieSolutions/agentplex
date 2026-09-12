import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UncommittedDiff } from '@agentplex/protocol';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { createFakeWorkingTree } from './fake-working-tree.js';
import { createGitWorkingTree, readWorkingTrees, DIRECTORIES_PER_REPORT } from './working-tree.js';

const DIRECTORY = '/volumes/work/project';
const DIFF_COMMAND = `git --no-optional-locks -C ${DIRECTORY} diff-index -M --numstat -z HEAD --`;
const STATUS_COMMAND = `git --no-optional-locks -C ${DIRECTORY} status --porcelain=v2 --branch`;

const ONE_FILE: UncommittedDiff = {
  files: 1,
  added: 3,
  removed: 1,
  entries: [{ path: 'src/auth/refresh.ts', added: 3, removed: 1 }],
};

/**
 * Captured `git status --porcelain=v2 --branch` output, the same fixtures
 * `git-status.test.ts` parses. Read from the files rather than restated here:
 * what this reader takes out of that format is the branch name, and a
 * hand-written header would be a test of the header somebody imagined.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'operations', 'fixtures', name), 'utf8');
}

const ON_A_BRANCH = fixture('git-status-clean.txt');
const DETACHED = fixture('git-status-detached.txt');
const NOT_A_REPOSITORY = fixture('git-not-a-repository.txt');

describe('the real reader', () => {
  it('answers with the branch git says is checked out', async () => {
    const trees = createGitWorkingTree({
      runner: createFakeProcessRunner({ outcomes: { [STATUS_COMMAND]: printed(ON_A_BRANCH) } }),
    });

    // The branch this repository's own checkout was on when the fixture was
    // captured, which is the point of reading it from the file.
    expect(await trees.branch(DIRECTORY)).toBe('agx-21-operation-registry');
  });

  it('answers null for a detached head, because there is no name to show', async () => {
    const trees = createGitWorkingTree({
      runner: createFakeProcessRunner({ outcomes: { [STATUS_COMMAND]: printed(DETACHED) } }),
    });

    expect(await trees.branch(DIRECTORY)).toBeNull();
  });

  it('answers with what git counted', async () => {
    const trees = createGitWorkingTree({
      runner: createFakeProcessRunner({
        outcomes: { [DIFF_COMMAND]: printed('3\t1\tsrc/auth/refresh.ts\0') },
      }),
    });

    expect(await trees.uncommitted(DIRECTORY)).toEqual(ONE_FILE);
  });

  it('answers null for every way a directory can fail to have an answer', async () => {
    // One shape for all of them, on purpose. A directory that is not a
    // repository, a repository with no commits, a path that is gone, a machine
    // with no git, and a request that does not parse are five different
    // problems and one fact about the screen: nobody read this, so draw
    // nothing. A zero in any of these cases would say a person has nothing
    // outstanding.
    const notARepository = createGitWorkingTree({
      runner: createFakeProcessRunner({
        outcomes: {
          [DIFF_COMMAND]: refused(128, NOT_A_REPOSITORY),
          [STATUS_COMMAND]: refused(128, NOT_A_REPOSITORY),
        },
      }),
    });
    expect(await notARepository.uncommitted(DIRECTORY)).toBeNull();
    expect(await notARepository.branch(DIRECTORY)).toBeNull();

    const noGit = createGitWorkingTree({ runner: createFakeProcessRunner() });
    expect(await noGit.uncommitted(DIRECTORY)).toBeNull();
    expect(await noGit.branch(DIRECTORY)).toBeNull();

    // A relative path never reaches a child: the operation refuses the request
    // and the argv builder is never called.
    const runner = createFakeProcessRunner();
    const unparseable = createGitWorkingTree({ runner });
    expect(await unparseable.uncommitted('project')).toBeNull();
    expect(await unparseable.branch('project')).toBeNull();
    expect(runner.requests).toEqual([]);
  });

  it('reads the branch and the diffstat with two separate questions to git', async () => {
    const runner = createFakeProcessRunner({
      outcomes: {
        [STATUS_COMMAND]: printed(ON_A_BRANCH),
        [DIFF_COMMAND]: printed('3\t1\tsrc/auth/refresh.ts\0'),
      },
    });
    const trees = createGitWorkingTree({ runner });

    await trees.branch(DIRECTORY);
    await trees.uncommitted(DIRECTORY);

    // Two children, and both of them `--no-optional-locks`: this runs against a
    // directory an agent is actively writing in, and a probe that takes
    // `.git/index.lock` can lose a race with the thing it is watching.
    expect(runner.requests.map((request) => request.args)).toEqual([
      ['--no-optional-locks', '-C', DIRECTORY, 'status', '--porcelain=v2', '--branch'],
      ['--no-optional-locks', '-C', DIRECTORY, 'diff-index', '-M', '--numstat', '-z', 'HEAD', '--'],
    ]);
  });
});

describe('one reading per directory in a report', () => {
  it('asks once for a directory several sessions share', async () => {
    const trees = createFakeWorkingTree(
      { [DIRECTORY]: ONE_FILE },
      { [DIRECTORY]: 'fix/auth-refresh' },
    );

    const found = await readWorkingTrees([DIRECTORY, DIRECTORY, DIRECTORY], trees);

    // Both questions answer for the whole repository whichever directory inside
    // it was named, so three sessions in one checkout are two children and not
    // six.
    expect(trees.askedUncommitted).toEqual([DIRECTORY]);
    expect(trees.askedBranch).toEqual([DIRECTORY]);
    expect(found.get(DIRECTORY)).toEqual({ branch: 'fix/auth-refresh', uncommitted: ONE_FILE });
  });

  it('keeps the half of a reading that answered when the other half did not', async () => {
    // A repository with no commit yet is on a branch and has nothing to be
    // different from. Half an answer is the true one, and collapsing it to
    // nothing would throw away a fact this machine read.
    const trees = createFakeWorkingTree({}, { [DIRECTORY]: 'main' });

    const found = await readWorkingTrees([DIRECTORY], trees);

    expect(found.get(DIRECTORY)).toEqual({ branch: 'main', uncommitted: null });
  });

  it('reports nothing for a directory neither question could answer', async () => {
    const trees = createFakeWorkingTree({ [DIRECTORY]: ONE_FILE }, { [DIRECTORY]: 'main' });

    const found = await readWorkingTrees([DIRECTORY, '/volumes/work/not-a-repo'], trees);

    // A directory that answered costs nothing to one that did not. Both nulls
    // are what reach a descriptor as "nobody looked".
    expect(found.get('/volumes/work/not-a-repo')).toEqual({ branch: null, uncommitted: null });
    expect(found.get(DIRECTORY)).toEqual({ branch: 'main', uncommitted: ONE_FILE });
  });

  it('stops asking after a bounded number of directories in one scan', async () => {
    const trees = createFakeWorkingTree();
    const many = Array.from({ length: DIRECTORIES_PER_REPORT + 4 }, (_, at) => `/volumes/w-${at}`);

    await readWorkingTrees(many, trees);

    // A report is sent on every scan, and a scan can be triggered by an agent
    // writing a line. What it costs has to be bounded by something other than
    // how many checkouts a store happens to hold; the ones past the cap report
    // that nobody looked, which is true. The cap counts directories, so adding
    // the branch to the reading did not move the number a store report is
    // bounded by.
    expect(trees.askedUncommitted).toHaveLength(DIRECTORIES_PER_REPORT);
    expect(trees.askedBranch).toHaveLength(DIRECTORIES_PER_REPORT);
    expect(trees.askedUncommitted).toEqual(many.slice(0, DIRECTORIES_PER_REPORT));
  });

  it('asks nothing when there is nothing to ask about', async () => {
    const trees = createFakeWorkingTree();

    expect(await readWorkingTrees([], trees)).toEqual(new Map());
    expect(trees.askedUncommitted).toEqual([]);
    expect(trees.askedBranch).toEqual([]);
  });
});
