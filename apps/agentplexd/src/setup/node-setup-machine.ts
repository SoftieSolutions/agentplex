import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter } from 'node:path';
import type { FileRead } from '@agentplex/providers';
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
      try {
        // 0600 on creation: the settings file holds the client token. A file
        // that is already there keeps the mode the installer gave it, which is
        // the same one.
        await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
        return { ok: true };
      } catch (error) {
        return { ok: false, problem: String(error) };
      }
    },
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
