import { z } from 'zod';
import {
  UNCOMMITTED_FILES_LISTED,
  type ChangedFile,
  type UncommittedDiff,
} from '@agentplex/protocol';
import type { CompletedProcess, Operation, OperationOutcome } from '@agentplex/providers';
import { directorySchema, firstLine } from './directory.js';

/**
 * The line counts behind "files changed": what is in a working tree now and is
 * not in `HEAD`.
 *
 * `git.status` already answers "is there anything uncommitted here" with a
 * count of entries. This answers the next question, which is the one the diff
 * panel draws: which files, and how many lines each way. The hub cannot do it —
 * the working tree is on this machine's disk — so it is a server operation, and
 * what it produces is the wire type itself rather than a shape something else
 * has to map.
 *
 * Which "changed" this is, and why it is the only one here, is written down on
 * `uncommittedDiffSchema` in the protocol: the short version is that the branch
 * sense needs a base ref nobody can choose honestly for an arbitrary checkout.
 *
 * Four deliberate choices in the argv:
 *
 * - **`diff-index` rather than `diff`.** Plumbing, so the output format is a
 *   contract rather than a convenience, and — the reason it actually matters —
 *   it refuses cleanly. `git diff` outside a repository prints seven kilobytes
 *   of usage text suggesting `--no-index` and exits 129, because it is trying
 *   to be helpful to a person at a terminal; `diff-index` says
 *   `fatal: not a git repository` and exits 128, which is a sentence a client
 *   can show. `diff-index` compares content and not just stat information, so a
 *   file whose mtime moved and whose bytes did not is correctly absent.
 * - **`-M`.** Rename detection, which `diff` does by default and plumbing does
 *   not. Without it a renamed file is a delete plus an add, and a pure rename
 *   reports its whole length added and removed — churn that never happened.
 * - **`--numstat -z`.** `--numstat` is counts and not a rendered table, and
 *   `-z` stops git escaping the path. Without `-z` a name with a newline or a
 *   quote in it comes back C-quoted and a name with a rename in it comes back
 *   as `{old => new}`, so parsing it would mean writing an unquoter — a second
 *   format to get wrong for a path nobody controls.
 * - **`--no-optional-locks`, and the directory as `-C`.** Both for the reasons
 *   `git.status` gives: a probe that takes `.git/index.lock` can lose a race
 *   with the agent it is watching, and a directory belongs in the argv a test
 *   asserts on rather than in a spawn cwd nobody can see.
 */
export const gitDiffRequestSchema = z.strictObject({ directory: directorySchema });
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;

export const gitDiffOperation: Operation<GitDiffRequest, UncommittedDiff> = {
  name: 'git.diff',
  summary: 'Uncommitted line counts, per file and in total, for a directory',
  request: gitDiffRequestSchema,

  argv: ({ directory }) => ({
    file: 'git',
    args: [
      '--no-optional-locks',
      '-C',
      directory,
      'diff-index',
      '-M',
      '--numstat',
      '-z',
      'HEAD',
      // Nothing follows, said out loud. Everything after `--` would be a
      // pathspec, and there is no request field that could put one there.
      '--',
    ],
  }),

  /**
   * Two seconds, the same budget `git.status` takes, and for the same reason: a
   * diff against `HEAD` on a warm repository is milliseconds, and one that is
   * slower than this is on a network mount or behind a lock. A session list
   * that blocks on it is worse than one that says it does not know.
   */
  timeoutMs: 2_000,

  read: readGitDiff,
};

/**
 * The `-z --numstat` record stream.
 *
 * One record per file, each terminated by NUL, and two shapes:
 *
 *     <added> TAB <removed> TAB <path> NUL
 *     <added> TAB <removed> TAB NUL <from> NUL <to> NUL
 *
 * The second is a rename or a copy, whose two paths are separate fields
 * precisely so that neither has to be escaped. `-` in place of a count is git
 * declining to count a binary.
 *
 * The counts are read by index rather than by splitting on tabs, because a file
 * name may contain a tab and `-z` does not escape it. The first two tabs end
 * the two counts; everything after the second tab is the path, tabs and all.
 */
function readGitDiff(
  completed: CompletedProcess,
  { directory }: GitDiffRequest,
): OperationOutcome<UncommittedDiff> {
  if (completed.exitCode !== 0) {
    // git's own words. Every case here is a fact about the directory rather
    // than a fault of this server's: not a repository, a repository with no
    // commit for `HEAD` to name, a path that is not there, an ownership git
    // will not trust. A refusal a caller can render, never an error.
    return {
      ok: false,
      refusal: 'failed',
      problem: `git could not diff ${directory}: ${firstLine(completed.stderr)}`,
    };
  }

  // A trailing NUL terminates the last record, so the final field is empty and
  // is not a record. An empty stdout is a clean tree and not a parse failure:
  // unlike a status, a diff with nothing to say says nothing.
  const fields = completed.stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();

  let files = 0;
  let added = 0;
  let removed = 0;
  const entries: ChangedFile[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record === '') {
      return malformed(directory, 'an empty record where a count was expected');
    }

    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      return malformed(directory, `a record with no counts on it: ${JSON.stringify(record)}`);
    }

    const counts = readCounts(record.slice(0, firstTab), record.slice(firstTab + 1, secondTab));
    if (counts === null) {
      return malformed(
        directory,
        `a count that is neither a number nor "-": ${record.slice(0, secondTab)}`,
      );
    }

    let path = record.slice(secondTab + 1);
    if (path === '') {
      // A rename or a copy: the two paths follow as their own fields. The
      // destination is the file that is there now, which is the one to show.
      const destination = fields[index + 2];
      if (fields[index + 1] === undefined || destination === undefined) {
        return malformed(directory, 'a rename record whose two paths were not both there');
      }
      path = destination;
      index += 2;
    }

    files += 1;
    added += counts.added ?? 0;
    removed += counts.removed ?? 0;
    if (entries.length < UNCOMMITTED_FILES_LISTED) {
      entries.push({ path: representable(path), ...counts });
    }
  }

  return { ok: true, result: { files, added, removed, entries } };
}

/** `-` is git declining to count a binary. Anything else is a whole count or a refusal. */
function readCounts(
  left: string,
  right: string,
): { added: number | null; removed: number | null } | null {
  if (left === '-' && right === '-') return { added: null, removed: null };

  const added = wholeCount(left);
  const removed = wholeCount(right);
  if (added === null || removed === null) return null;
  return { added, removed };
}

function wholeCount(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  const count = Number(field);
  return Number.isSafeInteger(count) ? count : null;
}

/**
 * The name, or `null` for one this process cannot say.
 *
 * A path on Linux is bytes, and the one-shot runner decodes a child's output as
 * UTF-8, so bytes that are not UTF-8 arrive as U+FFFD and the original is gone.
 * There is nothing to recover, so the choice is between dropping the file —
 * which would make the count on screen smaller than the truth — and showing a
 * name that is not the file's. `null` is neither: the row is still counted and
 * says only that its name cannot be shown.
 *
 * A name that genuinely contains U+FFFD is read as unrepresentable too. That is
 * the safe direction of a test that cannot distinguish them: it withholds a
 * name that would have been right, rather than asserting one that is wrong.
 */
const REPLACEMENT_CHARACTER = '\uFFFD';

function representable(path: string): string | null {
  return path === '' || path.includes(REPLACEMENT_CHARACTER) ? null : path;
}

function malformed(directory: string, problem: string): OperationOutcome<UncommittedDiff> {
  // Output that does not answer the question is not an empty answer. Reporting
  // a clean tree here would be a claim about a directory nobody managed to
  // read, which is exactly the over-claim a partial parse invites.
  return {
    ok: false,
    refusal: 'failed',
    problem: `git printed something this cannot read for ${directory}: ${problem}`,
  };
}
