import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  FileCreate,
  FileEntry,
  FileListing,
  FileRead,
  FileWrite,
  ProjectFileSystem,
} from './project-files.js';
import { nodeDataRoot } from './node-data-root.js';

/**
 * The real disk under the project file store, named in one place so nothing
 * below `main` reaches for it.
 *
 * `createDirectory` is the data root's, unchanged and not copied. It is the
 * same question asked of the same kernel -- make this directory and every
 * parent, tell me whether it was already there, refuse a path something else
 * occupies -- and a second implementation of it would be a second set of errno
 * mappings to keep in step with the first.
 *
 * `createFile` is `wx`: create, and fail if a file is already there. That is
 * one syscall with `O_EXCL`, so two servers racing on one folder cannot both
 * believe they wrote the note, and the one that lost is told `exists` rather
 * than silently overwriting what the winner recorded. A read followed by a
 * write would be the race rather than the answer to it, which is the same
 * argument `store-identity.ts` makes about the file at a store's root.
 *
 * `writeFile` is a write to a hidden temporary name in the same directory and
 * then a `rename` over the target. The rename is the atomic step: on every
 * filesystem a server runs on it replaces the directory entry in one
 * operation, so a reader sees the old document or the new one and never a
 * prefix of the new one, and a process killed between the two calls leaves an
 * intact document beside a hidden `.tmp` file rather than a truncated one.
 * The temporary name starts with a dot and ends in `.tmp`, and the document
 * name parser refuses both, so a leftover can neither be listed as a document
 * nor named by a frame. Same directory rather than the system temporary
 * directory, because a rename across filesystems is a copy and not atomic.
 *
 * `updatedAt` is read back off the disk after the write rather than taken
 * from a clock here, so the number a write answers with is the number the
 * listing will answer with next time somebody asks.
 *
 * `listFiles` stats each entry after the listing, and an entry that has gone
 * between the two -- a temporary file renamed away, a document removed by hand
 * -- costs itself and not the listing.
 *
 * `node-project-files.integration.test.ts` pins these claims against the real
 * runtime rather than against this paragraph.
 */
export const nodeProjectFiles: ProjectFileSystem = {
  createDirectory: (path: string) => nodeDataRoot.createDirectory(path),

  async createFile(path: string, contents: string): Promise<FileCreate> {
    try {
      await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
      return { kind: 'created' };
    } catch (error) {
      return errorCode(error) === 'EEXIST'
        ? { kind: 'exists' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async writeFile(path: string, contents: string): Promise<FileWrite> {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
      const written = await stat(path);
      return { kind: 'written', updatedAt: Math.round(written.mtimeMs) };
    } catch (error) {
      // Whichever of the three calls failed, the temporary file is either not
      // there or is the thing to remove, and removing a file that is not
      // there is not an error worth reporting over the one being reported.
      await rm(temporary, { force: true }).catch(() => undefined);
      return { kind: 'failed', reason: String(error) };
    }
  },

  async readFile(path: string): Promise<FileRead> {
    try {
      const [contents, found] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { kind: 'read', contents, updatedAt: Math.round(found.mtimeMs) };
    } catch (error) {
      return errorCode(error) === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async listFiles(path: string): Promise<FileListing> {
    let names: { readonly name: string; isFile(): boolean }[];
    try {
      names = await readdir(path, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }

    const entries: FileEntry[] = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      try {
        const found = await stat(join(path, entry.name));
        entries.push({
          name: entry.name,
          updatedAt: Math.round(found.mtimeMs),
          bytes: found.size,
        });
      } catch {
        // Gone or unreadable between the listing and the stat. It costs
        // itself: the entries that could be read are still the folder's.
      }
    }
    return { kind: 'listed', entries };
  },
};

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
