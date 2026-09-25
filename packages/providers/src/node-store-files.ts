import { readFile, stat, writeFile } from 'node:fs/promises';
import { errnoCode } from '@agentplex/node-shared';
import type { DirectoryState, FileCreate, FileRead, StoreFileSystem } from './store-identity.js';

/**
 * The real store volume, named in one place so tests never have to reach for a
 * disk.
 *
 * `wx` is the whole implementation of "mint once": the open is exclusive in
 * the kernel, so two servers starting against the same volume cannot both
 * create the file, and the loser is told so rather than discovering it by
 * reading back an id it did not write.
 */
export const nodeStoreFileSystem: StoreFileSystem = {
  async readFile(path: string): Promise<FileRead> {
    try {
      return { kind: 'read', contents: await readFile(path, 'utf8') };
    } catch (error) {
      return errnoCode(error) === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async statDirectory(path: string): Promise<DirectoryState> {
    try {
      // Follows symlinks on purpose: a store root that is a link to the volume
      // is a store root, and reporting the link rather than what it points at
      // would answer a question nobody asked.
      const entry = await stat(path);
      return entry.isDirectory() ? { kind: 'directory' } : { kind: 'not-a-directory' };
    } catch (error) {
      return errnoCode(error) === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async createFile(path: string, contents: string): Promise<FileCreate> {
    try {
      await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
      return { kind: 'created' };
    } catch (error) {
      return errnoCode(error) === 'EEXIST'
        ? { kind: 'exists' }
        : { kind: 'failed', reason: String(error) };
    }
  },
};
