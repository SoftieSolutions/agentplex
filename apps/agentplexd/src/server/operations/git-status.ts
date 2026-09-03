import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { CompletedProcess } from './process-runner.js';
import type { Operation, OperationOutcome } from './operation.js';

/**
 * What a session's working directory looks like to git right now.
 *
 * This is the operation the registry was designed against, and it is here
 * because the client needs it: a session in the list is a directory somebody is
 * working in, and "which branch, how far from its upstream, how much is
 * uncommitted" is the first thing a person wants to know about one before
 * opening a terminal. The hub cannot answer it — the directory is on the
 * server's disk and nowhere else — so it is a server-side operation.
 *
 * It is also the canonical case for the rule the ticket exists to encode. The
 * directory reaches git as `-C <dir>`, an argument git parses, rather than as a
 * cwd the kernel applies to the child. That is not decoration:
 *
 * - The argv is the whole truth about what ran, so a test asserts on one value
 *   and a log line records one line. A cwd is invisible state that a builder
 *   can forget to set and a reviewer cannot see.
 * - `git -C` fails loudly on a directory that is not there, in git's own words,
 *   where a spawn with a bad cwd fails as a spawn error that says nothing about
 *   which directory or why.
 * - There is exactly one place a path can appear, so there is exactly one place
 *   to validate it.
 *
 * `--no-optional-locks` is the other deliberate flag: without it git may write
 * `.git/index.lock` and refresh the index as a side effect of being asked a
 * question, and this runs against a directory an agent is actively working in.
 * A probe that takes a lock can lose a race with the thing it is watching.
 */
export interface GitStatus {
  /** The branch's short name, or `null` when HEAD is detached. */
  readonly branch: string | null;
  /** The upstream this branch tracks, or `null` when it tracks nothing. */
  readonly upstream: string | null;
  /** Commits ahead of the upstream, and behind it. Both 0 without an upstream. */
  readonly ahead: number;
  readonly behind: number;
  /**
   * How many entries git reported as changed: staged, unstaged, unmerged and
   * untracked together.
   *
   * Entries and not files, because git collapses an untracked directory into a
   * single entry, and counting its contents would mean walking a directory
   * whose size nobody bounded. A count that is sometimes low and never invented
   * is the direction to degrade in; `changes > 0` is the fact the client
   * actually renders.
   */
  readonly changes: number;
}

/**
 * A directory this operation will accept.
 *
 * Absolute, because a relative path would resolve against whatever directory
 * agentplexd happens to have been started in — and because an absolute path
 * cannot be mistaken by git for one of its own options. No NUL, because a NUL
 * truncates the path at the syscall, so what is opened is a prefix of what was
 * checked.
 *
 * Note what this does *not* do: it does not decide whether the directory is one
 * a session may look at. That is `parseWorkingDirectory`'s job at the point a
 * session's directory is chosen, and duplicating it here would put the same
 * policy in two places to drift apart.
 */
const directorySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'a directory may not contain a null byte')
  .refine(isAbsolute, 'a directory must be an absolute path');

export const gitStatusRequestSchema = z.strictObject({ directory: directorySchema });
export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;

export const gitStatusOperation: Operation<GitStatusRequest, GitStatus> = {
  name: 'git.status',
  summary: 'Branch, upstream distance and uncommitted change count for a directory',
  request: gitStatusRequestSchema,

  argv: ({ directory }) => ({
    file: 'git',
    args: ['--no-optional-locks', '-C', directory, 'status', '--porcelain=v2', '--branch'],
  }),

  /**
   * Two seconds. A `git status` on a warm repository is milliseconds; one that
   * takes longer than this is on a network mount or behind a lock, and a
   * session list that blocks on it is worse than one that says it does not
   * know.
   */
  timeoutMs: 2_000,

  read: readGitStatus,
};

/**
 * Porcelain v2, which is the format that exists to be parsed.
 *
 * Not `--porcelain=v1`, whose branch header is a single line of prose with the
 * ahead/behind counts inside brackets, and not the human format, which is
 * localised. v2 is defined line by line: `# key value` headers first, then one
 * line per changed entry, each beginning with `1`, `2`, `u`, `?` or `!`.
 */
function readGitStatus(
  completed: CompletedProcess,
  { directory }: GitStatusRequest,
): OperationOutcome<GitStatus> {
  if (completed.exitCode !== 0) {
    // git's own words, because they are better than any this could write: "not
    // a git repository", "detected dubious ownership", "permission denied". A
    // directory that is simply not a repository is the common case and is not a
    // fault, so it is a refusal a caller can render and not an error.
    return {
      ok: false,
      refusal: 'failed',
      problem: `git could not read ${directory}: ${firstLine(completed.stderr)}`,
    };
  }

  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  let sawHeader = false;

  for (const line of completed.stdout.split('\n')) {
    if (line === '') continue;

    if (!line.startsWith('# ')) {
      // Every other non-empty line is one entry git considers changed.
      changes += 1;
      continue;
    }

    const [key, ...rest] = line.slice('# '.length).split(' ');
    const value = rest.join(' ');

    if (key === 'branch.oid') sawHeader = true;
    // `(detached)` is a literal git prints where a name would go. Reporting it
    // as a branch would put a string nobody can check out in front of a user.
    else if (key === 'branch.head') branch = value === '(detached)' ? null : value;
    else if (key === 'branch.upstream') upstream = value;
    else if (key === 'branch.ab') ({ ahead, behind } = readAheadBehind(value));
  }

  if (!sawHeader) {
    // No headers means this was not the answer to the question that was asked —
    // a different git, a different format. An empty answer is not a clean
    // repository, and saying so would be a claim about a directory nobody read.
    return {
      ok: false,
      refusal: 'failed',
      problem: 'git printed no branch header, so this is not porcelain v2 output',
    };
  }

  return { ok: true, result: { branch, upstream, ahead, behind, changes } };
}

/** `+1 -2`. A count that does not parse is 0 rather than a guess. */
function readAheadBehind(value: string): { ahead: number; behind: number } {
  const [plus, minus] = value.split(' ');
  return { ahead: signedCount(plus, '+'), behind: signedCount(minus, '-') };
}

function signedCount(field: string | undefined, sign: string): number {
  if (field === undefined || !field.startsWith(sign)) return 0;
  const count = Number(field.slice(sign.length));
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line === undefined || line === '' ? 'it said nothing' : line;
}
