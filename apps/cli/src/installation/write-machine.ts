/**
 * The disk, as the two commands that change a prefix need it -- `agentplex
 * update` and `agentplex install`: the read-only questions `status` asks, and
 * the few things that change a prefix.
 *
 * `InstallationFiles` is deliberately not widened to hold these. That seam is
 * what makes `status`, `start` and `stop` structurally unable to write -- "a
 * command that changed the machine it was asked to describe" is a thing nobody
 * should have to think about -- and a seam is worth exactly as much as the
 * commands that cannot reach past it. So this is a second, wider seam held by
 * the commands that have a reason to write, and it extends the narrow one
 * rather than copying it: they read a prefix the same way `status` does,
 * and there is one answer to "what is a file read".
 *
 * What is on it is what the runtime swap, the package swap and the files an
 * install writes need, and nothing else; the units' state is systemd's. Every
 * method here exists because `install.sh` does the same thing in shell, and the
 * pairing is worth stating: `temporaryDirectory` is its `mktemp -d`, `sha256`
 * its `verify_checksum`, `makeDirectory`/`removeDirectory`/`rename` the
 * `mkdir -p`/`rm -rf`/`mv` that stage a tree beside the one it replaces and
 * move it in, `exists` its `[ -e ]`, `chmod` and `link` the `chmod 0755` and
 * `ln -sfn` that put the command on the prefix's `bin`, and `writeFile` the
 * runtime's stamp, the settings file and the units. The primitives pair; the
 * order does not. `ensure_node` removes the old runtime before the move, and
 * the swap in `runtime.ts` sets it aside first.
 *
 * The unpacking, the installing and the change of owner are not here: they are
 * `tar`, `npm` and `chown`, and every program agentplex starts goes through the
 * operation registry.
 */
import type { InstallationFiles } from './installation-files.js';

/** What one change to the disk did, in the two shapes a caller answers for. */
export type FileOutcome = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * The half of the network seam that writes a file rather than returning text:
 * `install.sh`'s `fetch`. The other half, which reads a manifest, is
 * `ManifestReader`.
 */
export interface Downloader {
  download(url: string, path: string): Promise<FileOutcome>;
}

export interface WriteFileOptions {
  readonly mode?: number;
}

export interface WriteMachine extends InstallationFiles {
  /**
   * A directory this run may put a download in, or `null` when the machine will
   * not give it one.
   *
   * Not a path this composes out of the prefix. A half-downloaded tarball under
   * `<prefix>` would be inside the directory `--uninstall` empties and the
   * directory the service account owns, and an interrupted run would leave
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
   * runtime at all should lie between two syscalls: the old runtime moved aside
   * and the new one moved in. A rename that fails can be undone by another, and
   * a copy that fails half way cannot.
   */
  rename(from: string, to: string): Promise<FileOutcome>;
  /**
   * Whether anything is at this path: a file, a directory, a link.
   *
   * Asked of a package's tree and of the `.old` a swap sets it aside as, where
   * the answer decides between a rename and leaving well alone. Only "nothing
   * there" is `false`: a path that cannot be looked at is reported as there,
   * so that the rename it leads to is what fails, with the reason in the
   * message, rather than a step that was skipped on a guess.
   */
  exists(path: string): Promise<boolean>;
  /** Sets a file's permission bits. */
  chmod(path: string, mode: number): Promise<FileOutcome>;
  /**
   * Points a symbolic link at `target`, replacing whatever link is at `path`.
   *
   * `target` is written as given, relative or not: the command's link is
   * relative, as npm makes it, so a prefix reached by another path still
   * resolves. Replaced in one rename rather than removed and remade, so there
   * is no moment at which the command is not on the prefix's `bin`.
   */
  link(target: string, path: string): Promise<FileOutcome>;
  /**
   * Writes a file whole: the runtime's stamp, the settings file, a unit.
   *
   * `mode` is the permission bits a file this write *creates* is created with,
   * before a byte is in it -- the settings file holds the client token, and a
   * file that is briefly world-readable is world-readable. It is the `umask
   * 077` the script wrote the settings file under, said per file rather than
   * per process. A file that already exists keeps its own bits; nothing that
   * passes one writes over a file that is there.
   */
  writeFile(path: string, contents: string, options?: WriteFileOptions): Promise<FileOutcome>;
  /** The SHA-256 of a file, as lowercase hex, or `null` if it could not be read. */
  sha256(path: string): Promise<string | null>;
}
