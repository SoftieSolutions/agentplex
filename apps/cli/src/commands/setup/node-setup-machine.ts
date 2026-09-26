import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import type { FileRead } from '@agentplex/providers';
import { errnoCode, isErrno } from '@agentplex/node-shared';
import type { DirectoryMade, FileWritten, SetupMachine } from './setup-machine.js';

/**
 * The real machine, named in one place so nothing else has to reach for a disk.
 *
 * `access(X_OK)` rather than a mode bit out of a `stat`, because the question is
 * "could this user run it" and the answer depends on who this user is, on group
 * membership and on the mount the file sits on. Reading `mode & 0o111` answers a
 * different question that happens to agree most of the time, and disagrees on
 * exactly the machines where somebody would have to debug it.
 *
 * Both probes swallow their errno, which is the one place in this codebase that
 * is the right thing to do with one: a path that cannot be reached is not a
 * candidate, and there is nothing an operator would do differently on a
 * `ENOTDIR` than on a `ENOENT` when the answer is only ever used to offer them
 * something.
 *
 * `writeFile` writes a hidden `.<name>.<uuid>.tmp` beside the target and
 * renames it over, the way the server's project files do, so a wizard killed
 * mid-write leaves the old settings file intact rather than a prefix of the new
 * one. It goes further than that precedent in three places, each for this
 * file: the temporary is opened `wx` at 0600, so it is never readable by
 * anyone else, even for the instant before its mode is set; it is `fsync`ed
 * before the rename, because a settings file that comes back empty after a
 * power cut is a hub that does not start; and when the target exists, the new
 * inode is given its owner, group and mode before it takes the name. A
 * `--system` settings file is root:agentplex 0640, read by systemd's
 * EnvironmentFile and by `doctor` as the service user, and a plain rename run
 * by root would leave it root:root 0600. The chown comes first, because a
 * chmod to 0640 on a file still in root's group opens it to that group, and a
 * chown clears set-id bits a chmod after it restores. A chown this user is not
 * allowed (EPERM: not root, and the file's group is not one of this user's) is
 * let go: the file becomes this user's with the mode it had, the nearest a new
 * inode this user makes can come. The directory is not fsynced after the
 * rename, as in the precedent: a crash before the directory reaches the disk
 * leaves the old file whole, which is the failure this write is built to allow.
 */
export interface NodeSetupMachineSources {
  /** `$HOME`, read at the entrypoint. */
  readonly home: string;
  /** `$PATH`, verbatim, split here because splitting it is this module's job. */
  readonly path: string | undefined;
}

export function createNodeSetupMachine({ home, path }: NodeSetupMachineSources): SetupMachine {
  return {
    home,
    // An empty entry in a PATH means the current directory, and a directory
    // nobody named is not a directory to adopt a provider out of — the same
    // reason `childEnvironment` drops them when it composes one.
    pathDirectories: (path ?? '').split(delimiter).filter((entry) => entry.length > 0),

    async isDirectory(candidate: string): Promise<boolean> {
      try {
        return (await stat(candidate)).isDirectory();
      } catch {
        return false;
      }
    },

    async isExecutable(candidate: string): Promise<boolean> {
      try {
        // A directory answers X_OK too — that bit means "searchable" on one —
        // so the file check is what keeps `<dir>/claude/` from reading as a
        // program named `claude`.
        if (!(await stat(candidate)).isFile()) return false;
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },

    async makeDirectory(path: string): Promise<DirectoryMade> {
      try {
        // `recursive` also makes an existing directory a success rather than an
        // EEXIST, which is the behaviour this seam promises: what is asked for
        // is the directory, not the creating of it.
        await mkdir(path, { recursive: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, problem: String(error) };
      }
    },

    async readFile(path: string): Promise<FileRead> {
      try {
        return { kind: 'read', contents: await readFile(path, 'utf8') };
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
        return { kind: 'failed', reason: String(error) };
      }
    },

    async writeFile(path: string, contents: string): Promise<FileWritten> {
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        const previous = await ownership(path);
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(contents, 'utf8');
          await handle.sync();
          if (previous !== undefined) {
            await handle.chown(previous.uid, previous.gid).catch((error: unknown) => {
              if (!isErrno(error, 'EPERM')) throw error;
            });
            await handle.chmod(previous.mode);
          }
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        return { ok: true };
      } catch (error) {
        // Whichever call failed, the temporary file is either not there or the
        // thing to remove, and a missing one is not worth reporting over the
        // failure being reported.
        await rm(temporary, { force: true }).catch(() => undefined);
        return { ok: false, problem: String(error) };
      }
    },
  };
}

interface Ownership {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/**
 * Who a file belongs to and its permission bits, or `undefined` when there is
 * no file. Only ENOENT means there is none: any other failure to look is a
 * failure to write, because guessing would hand the file a mode nobody chose.
 */
async function ownership(path: string): Promise<Ownership | undefined> {
  try {
    const found = await stat(path);
    return { uid: found.uid, gid: found.gid, mode: found.mode & 0o7777 };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}
