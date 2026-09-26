import { z } from 'zod';
import type { CompletedProcess, Operation, OperationOutcome } from '@agentplex/providers';
import { firstLine } from '@agentplex/node-shared';
import { directorySchema } from './directory.js';

/**
 * Which filter drivers a repository's own config defines, so that the two git
 * probes can switch each of them off.
 *
 * A clean or process filter is a program the repository's config names and
 * its attributes select, and git runs it on any stat-dirty file it has to read
 * the content of -- which both `status` and `diff-index` do. No flag turns
 * filters off wholesale: the only way is to name the driver, `-c
 * filter.<name>.clean=` and its siblings, and the repository picks the name.
 * So the probe has to ask first, and this is the asking.
 *
 * Only names with a key in the repository's own config are switched off: the
 * `local` scope, which includes whatever it `[include]`s, and `worktree`. A
 * user's global `filter.lfs` stays on, for the reason the fsmonitor and hooks
 * pairs leave `/etc/gitconfig` alone: the threat is whoever wrote the
 * checkout's `.git/config`, and the operator already runs what their own
 * config names. Switching `lfs` off would also make every stat-dirty LFS file
 * read as its content where the index holds a pointer, which is a change that
 * did not happen. A scope this does not recognise is treated as the
 * repository's, because switching off a filter that was harmless costs at
 * worst a wrong count, and leaving one on runs it.
 *
 * `git config` itself runs no filter, and it gets the same `-c` pairs and
 * `--no-optional-locks` the probes lead with so that the three children a
 * guarded probe starts are the same shape.
 *
 * Between this read and the probe there is a gap: a filter written into the
 * config after the read and before the probe runs is not switched off. The
 * agent working in the directory can write its config at any moment, so this
 * narrows the door to that window rather than shutting it.
 */
export const gitFilterNamesRequestSchema = z.strictObject({ directory: directorySchema });
export type GitFilterNamesRequest = z.infer<typeof gitFilterNamesRequestSchema>;

/**
 * How many repository filters a probe will switch off before it refuses.
 *
 * Each one is eight arguments of up to a few hundred bytes, and an argv is
 * bounded by the kernel. Sixty-four is far more than any real repository
 * configures and far below any `ARG_MAX`; a repository past it is one whose
 * config was written to make the argv fail, and it gets no reading.
 */
export const FILTER_NAMES_NEUTRALISED = 64;

/**
 * A driver name that `-c filter.<name>.clean=` can carry whole.
 *
 * git splits a `-c` argument at its first `=`, so a name with one would switch
 * off some other key and leave the filter on. A config file allows it, so it
 * can really arrive. A newline or a NUL cannot come out of the parser below,
 * which splits on both, and are refused here anyway because this is where
 * "can be an argument" is decided. The length is a bound, not a rule git has.
 */
export const filterNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => !/[=\n\0]/.test(name), {
    message: 'a filter name with "=", a newline or a NUL cannot be switched off with -c',
  });

/** The scopes that are the operator's rather than the repository's. */
const OPERATOR_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

export const gitFilterNamesOperation: Operation<GitFilterNamesRequest, readonly string[]> = {
  name: 'git.filter-names',
  summary: 'The filter drivers a repository configures itself, to switch off before a probe',
  request: gitFilterNamesRequestSchema,

  argv: ({ directory }) => ({
    file: 'git',
    args: [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '--no-optional-locks',
      '-C',
      directory,
      'config',
      '--null',
      '--show-scope',
      '--get-regexp',
      '^filter\\.',
    ],
  }),

  /** The probes' budget: it is one more question about the same checkout. */
  timeoutMs: 2_000,

  read: readFilterNames,
};

/**
 * The `-c` pairs that switch each named driver off, in the order given.
 *
 * An empty `clean`, `smudge` or `process` is no driver at all. `required=false`
 * is not decoration: a repository can mark its driver required, and git dies
 * rather than pass a file through a required filter that has no command.
 */
export function filterSwitches(names: readonly string[]): string[] {
  return names.flatMap((name) => [
    '-c',
    `filter.${name}.clean=`,
    '-c',
    `filter.${name}.smudge=`,
    '-c',
    `filter.${name}.process=`,
    '-c',
    `filter.${name}.required=false`,
  ]);
}

/**
 * `--null --show-scope` output: each record is a scope and an entry, each
 * terminated by NUL.
 *
 *     <scope> NUL <key> LF <value> NUL
 *     <scope> NUL <key> NUL
 *
 * The second shape is a key written with no value (`required` on its own
 * line). A value may contain a newline and a key may not, so the key runs to
 * the first newline. The name runs from after `filter.` to the key's last dot,
 * because a driver's name may contain dots and a variable name may not: the
 * name of `filter.a.b.clean` is `a.b`. A key with no name at all -- `[filter]
 * x = y` -- names no driver and is skipped.
 */
function readFilterNames(
  completed: CompletedProcess,
  { directory }: GitFilterNamesRequest,
): OperationOutcome<readonly string[]> {
  // `--get-regexp` says "no key matched" with exit 1 and nothing printed.
  if (completed.exitCode === 1 && completed.stdout === '') return { ok: true, result: [] };

  if (completed.exitCode !== 0) {
    return refuse(
      directory,
      `git could not read it: ${firstLine(completed.stderr) || 'it said nothing'}`,
    );
  }

  const fields = completed.stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 2 !== 0) {
    return refuse(directory, 'git printed a scope with no key after it');
  }

  const names: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const scope = fields[index] ?? '';
    const entry = fields[index + 1] ?? '';
    if (OPERATOR_SCOPES.has(scope)) continue;

    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const lastDot = key.lastIndexOf('.');
    if (!key.startsWith('filter.') || lastDot < 'filter.'.length) continue;

    const parsed = filterNameSchema.safeParse(key.slice('filter.'.length, lastDot));
    if (!parsed.success) {
      return refuse(
        directory,
        `the repository names a filter this cannot switch off: ${JSON.stringify(key)}`,
      );
    }
    if (!names.includes(parsed.data)) names.push(parsed.data);
  }

  if (names.length > FILTER_NAMES_NEUTRALISED) {
    return refuse(
      directory,
      `the repository configures ${names.length} filters, more than the ${FILTER_NAMES_NEUTRALISED} a probe switches off`,
    );
  }

  return { ok: true, result: names };
}

function refuse(directory: string, problem: string): OperationOutcome<readonly string[]> {
  // A refusal and never an empty list: an empty list would let the probe run
  // with every filter on, which is the one outcome this read exists to prevent.
  return {
    ok: false,
    refusal: 'failed',
    problem: `the filters of ${directory} could not be read: ${problem}`,
  };
}
