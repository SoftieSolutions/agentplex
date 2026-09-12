import type { FileCreate, ProjectFileSystem } from './project-files.js';
import type { DirectoryCreate } from './data-root.js';

/**
 * An in-memory disk for the project file store.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `createFakeDataRoot` is one: the subject is what the disk answered, so a test
 * that says "this folder is there and this file cannot be written" is
 * describing a machine rather than stubbing a call.
 *
 * It records every path it was asked to make or write, because the rule with
 * the most at stake here is a negative one -- nothing is written outside the
 * project root, and in particular nothing is written in the user's working tree
 * -- and a negative rule can only be asserted against a record of everything
 * that happened.
 */
export interface FakeProjectFilesOptions {
  /** Folders already there. Absent means nothing has been filed yet. */
  readonly directories?: readonly string[];
  /** Paths where something that is not a directory is in the way. */
  readonly notDirectories?: readonly string[];
  /** Paths whose creation fails: a read-only mount, a full disk. */
  readonly uncreatable?: readonly string[];
  /** Files already on the disk, by path. */
  readonly existingFiles?: Readonly<Record<string, string>>;
  /** Paths where a file cannot be written. */
  readonly unwritableFiles?: readonly string[];
}

export interface FakeProjectFiles extends ProjectFileSystem {
  /** Every path a directory create was attempted at, in order. */
  readonly creates: readonly string[];
  /** Every file on the disk now, by path. */
  readonly written: ReadonlyMap<string, string>;
}

export function createFakeProjectFiles(options: FakeProjectFilesOptions = {}): FakeProjectFiles {
  const directories = new Set(options.directories ?? []);
  const notDirectories = new Set(options.notDirectories ?? []);
  const uncreatable = new Set(options.uncreatable ?? []);
  const unwritableFiles = new Set(options.unwritableFiles ?? []);
  const written = new Map(Object.entries(options.existingFiles ?? {}));
  const creates: string[] = [];

  return {
    async createDirectory(path: string): Promise<DirectoryCreate> {
      creates.push(path);
      if (notDirectories.has(path)) return { kind: 'not-a-directory' };
      if (directories.has(path)) return { kind: 'exists' };
      if (uncreatable.has(path)) return { kind: 'failed', reason: `EROFS: ${path}` };
      directories.add(path);
      return { kind: 'created' };
    },

    async createFile(path: string, contents: string): Promise<FileCreate> {
      if (written.has(path)) return { kind: 'exists' };
      if (unwritableFiles.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      written.set(path, contents);
      return { kind: 'created' };
    },

    get creates() {
      return creates;
    },

    get written() {
      return written;
    },
  };
}
