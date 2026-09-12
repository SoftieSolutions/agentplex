import type { DataRootFileSystem, DirectoryCreate, WriteAccess } from './data-root.js';

/**
 * An in-memory disk for the data root.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `createFakeStoreFiles` is one: the whole subject is what the disk answered,
 * so a test that says "this directory is there and this one cannot be written
 * in" is describing a machine, not stubbing a call. It records what was
 * created, because "the server made the directory it was configured with" is
 * the assertion, and a spy on `mkdir` would be a different one.
 */
export interface FakeDataRootOptions {
  /** Directories already there. Absent means this run is the first one. */
  readonly directories?: readonly string[];
  /** Paths where something that is not a directory is in the way. */
  readonly files?: readonly string[];
  /** Paths whose creation fails: a read-only mount, a full disk, a missing parent. */
  readonly uncreatable?: readonly string[];
  /** Directories that exist and that this process may not write in. */
  readonly unwritable?: readonly string[];
}

export interface FakeDataRoot extends DataRootFileSystem {
  /** Every path a create was attempted at, in order. */
  readonly creates: readonly string[];
}

export function createFakeDataRoot(options: FakeDataRootOptions = {}): FakeDataRoot {
  const directories = new Set(options.directories ?? []);
  const files = new Set(options.files ?? []);
  const uncreatable = new Set(options.uncreatable ?? []);
  const unwritable = new Set(options.unwritable ?? []);
  const creates: string[] = [];

  return {
    async createDirectory(path: string): Promise<DirectoryCreate> {
      creates.push(path);
      if (files.has(path)) return { kind: 'not-a-directory' };
      if (directories.has(path)) return { kind: 'exists' };
      if (uncreatable.has(path)) return { kind: 'failed', reason: `EROFS: ${path}` };
      directories.add(path);
      return { kind: 'created' };
    },

    async checkWritable(path: string): Promise<WriteAccess> {
      return unwritable.has(path)
        ? { kind: 'denied', reason: `EACCES: ${path}` }
        : { kind: 'writable' };
    },

    get creates() {
      return creates;
    },
  };
}
