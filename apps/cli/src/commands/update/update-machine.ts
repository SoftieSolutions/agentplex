/**
 * The disk, as `agentplex update` needs it: the read-only questions `status`
 * asks, and the six things that change a prefix.
 *
 * `InstallationFiles` is deliberately not widened to hold these. That seam is
 * what makes `status`, `start` and `stop` structurally unable to write -- "a
 * command that changed the machine it was asked to describe" is a thing nobody
 * should have to think about -- and a seam is worth exactly as much as the
 * commands that cannot reach past it. So this is a second, wider seam held by
 * the one command that has a reason to write, and it extends the narrow one
 * rather than restating it: `update` reads a prefix the same way `status` does,
 * and there is one answer to "what is a file read".
 *
 * What is on it is the runtime swap and nothing else. The packages are npm's
 * job and go through the operation registry; the units are systemd's. Every
 * method here exists because `install.sh`'s `ensure_node` does the same thing
 * in shell, and the pairing is worth stating: `temporaryDirectory` is its
 * `mktemp -d`, `download` its `fetch`, `sha256` its `verify_checksum`,
 * `makeDirectory`/`removeDirectory`/`rename` the `rm -rf`/`mv` that put an
 * unpacked runtime into place, and `writeFile` the stamp it leaves behind.
 *
 * The unpacking itself is not here: it is `tar`, and every program agentplex
 * starts goes through the operation registry.
 */
import type { InstallationFiles } from '../../installation/installation-files.js';

/** What one change to the disk did, in the two shapes a caller answers for. */
export type FileOutcome = { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface UpdateMachine extends InstallationFiles {
  /**
   * A directory this run may put a download in, or `null` when the machine will
   * not give it one.
   *
   * Not a path this composes out of the prefix. A half-downloaded tarball under
   * `<prefix>` would be inside the directory `--uninstall` empties and the
   * directory the service account owns, and an interrupted update would leave
   * it there for ever. The machine's own temporary directory is swept by the
   * machine.
   */
  temporaryDirectory(): Promise<string | null>;
  /** Creates a directory and its parents. One that is already there is success. */
  makeDirectory(path: string): Promise<FileOutcome>;
  /** Removes a directory and everything in it. One that is not there is success. */
  removeDirectory(path: string): Promise<FileOutcome>;
  /**
   * Moves a directory into place.
   *
   * A rename and not a copy, because the window in which this machine has no
   * runtime at all should be one syscall long. `ensure_node` unpacks beside the
   * old runtime and moves for exactly that reason.
   */
  rename(from: string, to: string): Promise<FileOutcome>;
  /** Writes a file whole. What is written through this is the runtime's stamp. */
  writeFile(path: string, contents: string): Promise<FileOutcome>;
  /** The SHA-256 of a file, as lowercase hex, or `null` if it could not be read. */
  sha256(path: string): Promise<string | null>;
  /**
   * Puts one yes-or-no question to whoever is at this machine.
   *
   * `nobody` is a third answer and not a `false`, because the two lead
   * somewhere different: a person who said no has decided, and a run with
   * nobody at it has not been asked. The runtime is skipped either way and the
   * line printed is different, which is the whole of `--node`/`--no-node`
   * existing -- an unattended run should be able to say what it wants in
   * advance rather than be guessed at.
   *
   * Whether there is anybody is decided by *opening* `/dev/tty` rather than
   * testing it, which is `have_terminal()`'s rule and the one thing about this
   * seam that was learned the hard way: `[ -r /dev/tty ]` answers yes in a
   * container with no controlling terminal, and the open then fails with ENXIO.
   * A check that says yes and a prompt that then hangs is worse than either --
   * it is an update stopped halfway with the daemons already down.
   */
  askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'>;
}
