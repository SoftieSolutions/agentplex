import type { FileCreate, FileRead, StoreFileSystem } from './store-identity.js';

/**
 * An in-memory store volume.
 *
 * The disk is the one thing store identity is entirely about, so the tests get
 * a real implementation of the seam rather than a mock: files that exist, a
 * create that refuses to clobber, and hooks for the two failures that matter —
 * a file that cannot be read, and another process winning the mint.
 */
export interface FakeStoreFilesOptions {
  /** Files already on the volume, as `path -> contents`. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths whose read fails for a reason that is not absence: a mode bit, a directory. */
  readonly unreadable?: readonly string[];
  /** Paths whose create fails: a read-only mount, a full disk. */
  readonly unwritable?: readonly string[];
  /**
   * Awaited before every create, so a test can let another server mint first
   * and exercise the losing side of the race rather than describing it.
   */
  readonly beforeCreate?: (path: string) => void | Promise<void>;
}

export interface FakeStoreFiles extends StoreFileSystem {
  /** The volume as it now stands, for asserting that a bad file was left alone. */
  readonly contents: ReadonlyMap<string, string>;
  /** Every path a create was attempted at, in order. */
  readonly creates: readonly string[];
}

export function createFakeStoreFiles(options: FakeStoreFilesOptions = {}): FakeStoreFiles {
  const files = new Map(Object.entries(options.files ?? {}));
  const unreadable = new Set(options.unreadable ?? []);
  const unwritable = new Set(options.unwritable ?? []);
  const creates: string[] = [];

  return {
    async readFile(path: string): Promise<FileRead> {
      if (unreadable.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      const contents = files.get(path);
      return contents === undefined ? { kind: 'missing' } : { kind: 'read', contents };
    },

    async createFile(path: string, contents: string): Promise<FileCreate> {
      creates.push(path);
      await options.beforeCreate?.(path);
      if (unwritable.has(path)) return { kind: 'failed', reason: `EROFS: ${path}` };
      // Exclusive by construction: the fake cannot overwrite, because the real
      // implementation must not be able to either.
      if (files.has(path)) return { kind: 'exists' };
      files.set(path, contents);
      return { kind: 'created' };
    },

    get contents() {
      return files;
    },
    get creates() {
      return creates;
    },
  };
}
