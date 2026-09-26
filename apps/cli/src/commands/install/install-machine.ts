import type { InstallationFiles } from '../../installation/installation-files.js';

/**
 * The disk, as `agentplex install` needs it so far: the read-only questions the
 * other installation commands ask, and the listing of one directory.
 *
 * Nothing here writes. This command plans an install and prints units; the
 * install that writes them is the next change, and it widens this seam then
 * rather than now. A command that can only read is one a test does not have to
 * prove changed nothing.
 *
 * `listDirectory` is for `AGENTPLEX_PACKAGE`, whose tarballs are found by name
 * the way `package_tarball`'s glob finds them.
 */
export interface InstallMachine extends InstallationFiles {
  /** The names in a directory, or `null` when it is not one that can be listed. */
  listDirectory(path: string): Promise<readonly string[] | null>;
}
