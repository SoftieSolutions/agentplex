import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import type { DataRootFileSystem, DirectoryCreate, WriteAccess } from './data-root.js';

/**
 * The real disk, named in one place so nothing below `main` reaches for it.
 *
 * `recursive: true` is both halves of what `createDirectory` promises: it
 * makes every missing parent, and it succeeds rather than failing on a
 * directory that is already there -- which is the ordinary case on every start
 * after the first, and would otherwise have to be told apart from a real
 * collision by matching on an errno. The one thing it does fail on is a path
 * occupied by something that is not a directory, which is exactly the case the
 * rule has to refuse.
 *
 * Its return value is the seam's `created` flag: Node resolves it with the
 * first directory it had to make, and with `undefined` when there was nothing
 * to make. `node-data-root.integration.test.ts` pins that against the real
 * runtime rather than against this paragraph.
 *
 * Write access is asked with `access` rather than demonstrated with a probe
 * file: the answer is wanted before anything is written, and a check that
 * leaves a file behind is a check that has to clean up after itself on the
 * path where everything went right. `X_OK` comes with `W_OK` because a
 * directory that cannot be traversed cannot be written into either, and the
 * two arrive as one errno anyway.
 */
export const nodeDataRoot: DataRootFileSystem = {
  async createDirectory(path: string): Promise<DirectoryCreate> {
    try {
      const first = await mkdir(path, { recursive: true });
      return first === undefined ? { kind: 'exists' } : { kind: 'created' };
    } catch (error) {
      const code = errorCode(error);
      return code === 'EEXIST' || code === 'ENOTDIR'
        ? { kind: 'not-a-directory' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async checkWritable(path: string): Promise<WriteAccess> {
    try {
      await access(path, constants.W_OK | constants.X_OK);
      return { kind: 'writable' };
    } catch (error) {
      return { kind: 'denied', reason: String(error) };
    }
  },
};

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
