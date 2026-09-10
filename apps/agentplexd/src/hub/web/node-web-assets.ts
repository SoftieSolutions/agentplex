import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { WebAssetFileSystem } from './web-assets.js';

/**
 * The real disk, named in one place so tests never have to reach for it — and
 * so that the containment rule below exists exactly once.
 */

/**
 * The read failures that mean "there is no such file".
 *
 * Everything else is let out. A file that is there and cannot be read — a mode
 * bit, a mount that went away, a descriptor limit — is not absence, and
 * flattening it into one would answer 404 for a build that is sitting right
 * there and leave the operator with nothing to go on.
 */
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EINVAL']);

export function createNodeWebAssets(root: string): WebAssetFileSystem {
  const base = resolve(root);

  return {
    root: base,
    read: async (file) => {
      // `resolve` collapses the path and, given an absolute one, discards the
      // base entirely — so this is checked rather than assumed. The caller
      // has already refused every traversal it could see; two independent
      // checks is the point, because this one holds whoever the caller is.
      const path = resolve(base, file);
      if (path !== base && !path.startsWith(base + sep)) return null;

      try {
        return await readFile(path);
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
    },
  };
}

/** A thrown value is a claim like any other: it is read, never asserted about. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ABSENT.has(error.code)
  );
}
