import { join } from 'node:path';

/**
 * The machine setup is standing on, as the few facts a wizard needs from it.
 *
 * Injected like every other seam, and narrow on purpose: a home directory, the
 * directories the operator's own shell resolves programs in, and two questions
 * about a path. Everything else the wizard learns it learns by running a program
 * through the setup operation registry, which is the one place a child is
 * started.
 *
 * The two facts arrive as values rather than being read here, because the
 * entrypoint is the only reader of `process.env` and `PATH` is an environment
 * variable like any other. That is also what makes the whole discovery path
 * testable: a machine with homebrew on it and a machine with nothing on it are
 * two literals, not two containers.
 */
export interface SetupMachine {
  /** The operator's home directory. The owned prefix and the stores hang off it. */
  readonly home: string;
  /**
   * The directories the operator's own PATH names, in search order.
   *
   * This is the list adoption is decided against. It is the operator's PATH and
   * not the service's, deliberately: the point of the exercise is to find the
   * binary they installed and authenticated, which is by definition the one
   * their shell resolves.
   */
  readonly pathDirectories: readonly string[];
  /**
   * Whether there is a directory at this path.
   *
   * A boolean rather than an errno, unlike the store filesystem's reads, and the
   * difference is what the answer is for: a store that cannot be read is a
   * failure an operator has to be told about, where a candidate directory that
   * cannot be read is simply not a candidate — the wizard offers it or it does
   * not, and the operator can type a path either way.
   */
  isDirectory(path: string): Promise<boolean>;
  /** Whether there is a file at this path that this user could execute. */
  isExecutable(path: string): Promise<boolean>;
  /**
   * Creates a directory and its parents. A directory that is already there is
   * success, because what is being asked for is the directory, not the creating.
   *
   * The one thing on this seam that writes, and it is here rather than on the
   * store filesystem for a reason worth stating: `createFile` there is exclusive
   * in the kernel and refuses to clobber, which is what makes "mint once" true,
   * and a seam that can also make directories is a seam somebody can be tempted
   * to make one *with*. What this creates is the prefix agentplex owns, which
   * the wizard chose the location of two screens earlier — nothing in a
   * provider's state directory, and nothing in a store.
   */
  makeDirectory(path: string): Promise<DirectoryMade>;
}

export type DirectoryMade =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Every directory on the operator's PATH holding a program of this name, in
 * search order.
 *
 * This is the whole mechanism behind adoption. A program name resolves to
 * whichever of these directories comes first, so the first entry is the binary
 * the operator has been using — the one they authenticated — and recording that
 * directory is what makes the service resolve the same one. The rest of the list
 * is not thrown away: two copies of a provider on one PATH is the fact behind a
 * version that surprises somebody later, and it costs nothing to have found out
 * while a person is present.
 *
 * A name with a separator in it is not a program name and is refused rather than
 * joined, so this can never search a directory other than the one it was asked
 * about. The operation registry's rule that a path never appears where a program
 * name belongs is the same rule, one layer up.
 */
export async function findProgram(
  program: string,
  machine: SetupMachine,
): Promise<readonly string[]> {
  if (program.length === 0 || program.includes('/') || program.includes('\0')) return [];

  const found: string[] = [];
  for (const directory of machine.pathDirectories) {
    if (await machine.isExecutable(join(directory, program))) found.push(directory);
  }

  // One directory named twice on a PATH is one directory. It would otherwise
  // reach a plan's `binPath` twice, where the parser dedupes it anyway, and read
  // as two copies of a provider in the wizard's own report.
  return found.filter((directory, index) => found.indexOf(directory) === index);
}
