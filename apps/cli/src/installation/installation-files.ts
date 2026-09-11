import type { FileRead } from '@agentplex/providers';

/**
 * The disk, as the three installation commands read it: two questions, neither
 * of which writes anything.
 *
 * Narrow because the commands are. `status` is read-only for the reason
 * `doctor` is -- a command that changed the machine it was asked to describe
 * makes "run status first" a thing you have to think about -- and `start` and
 * `stop` change the machine only through `systemctl`, which is the other seam.
 * Neither can create a directory, write a file or remove one, because there is
 * nowhere on this type to ask for it. `SetupMachine` is the wider seam, and
 * setup is the command that has a reason to write.
 *
 * `FileRead` comes from the store filesystem rather than being declared again,
 * because it is the same three answers to the same question and a second
 * spelling of "missing" would eventually be handled in only one of the two
 * places.
 */
export interface InstallationFiles {
  /** A file's contents, that there is none, or why it could not be read. */
  readFile(path: string): Promise<FileRead>;
  /**
   * Whether there is a regular file at this path.
   *
   * A boolean rather than an errno, and a regular file rather than any entry.
   * What this is asked about is a unit file and an interpreter, and the only
   * thing either answer is used for is deciding whether to name it: a path that
   * cannot be reached is a path with no unit at it, and there is nothing an
   * operator would do differently about an `ENOTDIR` than about an `ENOENT`
   * when the consequence is a line that is printed or is not.
   */
  isFile(path: string): Promise<boolean>;
}
