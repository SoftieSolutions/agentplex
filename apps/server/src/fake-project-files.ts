import { basename, dirname } from 'node:path';
import type {
  FileCreate,
  FileEntry,
  FileListing,
  FileRead,
  FileWrite,
  ProjectFileSystem,
} from './project-files.js';
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
 *
 * Write times are a counter rather than a clock: what a test asserts about
 * `updatedAt` is that it is the time of the write that produced the file and
 * not of some other one, and a counter says that without a clock to inject.
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
  /** Paths where a file is there and cannot be read: a permission, a bad block. */
  readonly unreadableFiles?: readonly string[];
  /**
   * What a directory listing answers at a path, in place of what the files
   * above would say. For a listing captured off a real disk, so that what the
   * rules above the seam are tested against is what a real `readdir` and
   * `stat` produced rather than what a test author imagined they would.
   */
  readonly listings?: Readonly<Record<string, FileListing>>;
}

export interface FakeProjectFiles extends ProjectFileSystem {
  /** Every path a directory create was attempted at, in order. */
  readonly creates: readonly string[];
  /** Every file on the disk now, by path. */
  readonly written: ReadonlyMap<string, string>;
  /** Every path a write was attempted at, in order, whether or not it landed. */
  readonly writes: readonly string[];
}

export function createFakeProjectFiles(options: FakeProjectFilesOptions = {}): FakeProjectFiles {
  const directories = new Set(options.directories ?? []);
  const notDirectories = new Set(options.notDirectories ?? []);
  const uncreatable = new Set(options.uncreatable ?? []);
  const unwritableFiles = new Set(options.unwritableFiles ?? []);
  const unreadableFiles = new Set(options.unreadableFiles ?? []);
  const listings = new Map(Object.entries(options.listings ?? {}));
  const written = new Map(Object.entries(options.existingFiles ?? {}));
  const writtenAt = new Map<string, number>();
  const creates: string[] = [];
  const writes: string[] = [];
  let tick = 0;

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
      writtenAt.set(path, (tick += 1));
      return { kind: 'created' };
    },

    async writeFile(path: string, contents: string): Promise<FileWrite> {
      writes.push(path);
      if (unwritableFiles.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      if (!directories.has(dirname(path))) return { kind: 'failed', reason: `ENOENT: ${path}` };
      written.set(path, contents);
      const updatedAt = (tick += 1);
      writtenAt.set(path, updatedAt);
      return { kind: 'written', updatedAt };
    },

    async readFile(path: string): Promise<FileRead> {
      if (unreadableFiles.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      const contents = written.get(path);
      if (contents === undefined) return { kind: 'missing' };
      return { kind: 'read', contents, updatedAt: writtenAt.get(path) ?? 0 };
    },

    async listFiles(path: string): Promise<FileListing> {
      const captured = listings.get(path);
      if (captured !== undefined) return captured;
      if (!directories.has(path)) return { kind: 'missing' };
      const entries: FileEntry[] = [];
      for (const [file, contents] of written) {
        if (dirname(file) !== path) continue;
        entries.push({
          name: basename(file),
          updatedAt: writtenAt.get(file) ?? 0,
          bytes: Buffer.byteLength(contents, 'utf8'),
        });
      }
      return { kind: 'listed', entries };
    },

    get creates() {
      return creates;
    },

    get written() {
      return written;
    },

    get writes() {
      return writes;
    },
  };
}
