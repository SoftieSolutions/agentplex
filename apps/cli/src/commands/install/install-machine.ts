import type { WriteMachine } from '../../installation/write-machine.js';

/**
 * The disk, as `agentplex install` needs it: the write seam `update` holds --
 * the packages staged and swapped, the settings file and the units written --
 * and the listing of one directory.
 *
 * Wide because the command is: it is the one that puts a machine's install in
 * place. `--print-unit` and `--dry-run` hold the same seam and use only its
 * questions, which the fake records, so a test can still prove they changed
 * nothing.
 *
 * `listDirectory` is for `AGENTPLEX_PACKAGE`, whose tarballs are found by name
 * the way `package_tarball`'s glob finds them.
 */
export interface InstallMachine extends WriteMachine {
  /** The names in a directory, or `null` when it is not one that can be listed. */
  listDirectory(path: string): Promise<readonly string[] | null>;
}
