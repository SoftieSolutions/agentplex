import { writeFile } from 'node:fs/promises';
import type { FileCreate, ProjectFileSystem } from './project-files.js';
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
 * `node-project-files.integration.test.ts` pins both claims against the real
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
};

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
