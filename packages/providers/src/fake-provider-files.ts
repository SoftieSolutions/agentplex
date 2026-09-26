import { createHash } from 'node:crypto';
import type { FileRead } from './store-identity.js';
import type {
  DirectoryEntry,
  DirectoryRead,
  FileStatRead,
  ProviderFiles,
  TailRead,
} from './provider-files.js';

/**
 * A store volume an adapter can be pointed at in a test.
 *
 * A real implementation of the seam rather than a mock, for the same reason
 * `fake-store-files` is one: the behaviour under test is what an adapter does
 * with directories that are absent, directories that refuse to be listed, and
 * files that are there but unreadable, and those are values the seam can
 * produce rather than interactions to assert on.
 *
 * Directories are implied by the paths of the files in them, so a test writes
 * one map and gets a tree.
 */
export interface FakeProviderFilesOptions {
  /** Files on the volume, as `path -> contents`. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths — file or directory — that fail for a reason that is not absence. */
  readonly unreadable?: readonly string[];
  /** Directories that exist and hold nothing, which no file path can imply. */
  readonly directories?: readonly string[];
  /**
   * Files whose mtime a test states, as `path -> epoch ms`. Every other file's
   * is derived from its contents; see `mtimeOf`.
   */
  readonly mtimes?: Readonly<Record<string, number>>;
  /**
   * Files that are listed and cannot be stat'ed: what a directory with read
   * permission and no search permission does to everything in it.
   *
   * Separate from `unreadable` because the real filesystem keeps them apart.
   * A file nobody may read still answers `stat`, since that asks the directory
   * and not the file, so an `unreadable` file stats and then fails to read.
   */
  readonly unstatable?: readonly string[];
}

/**
 * The fake, and what a test can see and change of it.
 *
 * `reads` and `stats` are here because the behaviour a discovery cache has to
 * get right is an absence: a second scan of an unchanged store reads nothing.
 * The answer alone cannot show that, since a cached parse and a fresh one of
 * the same bytes are equal; only the record of what was asked for can.
 */
export interface FakeProviderFiles extends ProviderFiles {
  /** Every path `readFile` was asked for, in order, repeats included. */
  readonly reads: readonly string[];
  /** Every path `stat` was asked for, in order, repeats included. */
  readonly stats: readonly string[];
  /**
   * Put `contents` at `path`, as a provider appending a turn or rewriting a
   * file would. `mtimeMs`, when given, is the file's new mtime; otherwise it
   * is derived from the contents like any other file's.
   */
  write(path: string, contents: string, mtimeMs?: number): void;
  /** Delete the file at `path`, as a provider pruning old sessions would. */
  remove(path: string): void;
}

export function createFakeProviderFiles(options: FakeProviderFilesOptions = {}): FakeProviderFiles {
  const files = new Map(Object.entries(options.files ?? {}));
  const mtimes = new Map(Object.entries(options.mtimes ?? {}));
  const unreadable = new Set(options.unreadable ?? []);
  const unstatable = new Set(options.unstatable ?? []);
  const empty = new Set(options.directories ?? []);
  const reads: string[] = [];
  const stats: string[] = [];

  return {
    reads,
    stats,

    write(path: string, contents: string, mtimeMs?: number): void {
      files.set(path, contents);
      if (mtimeMs === undefined) mtimes.delete(path);
      else mtimes.set(path, mtimeMs);
    },

    remove(path: string): void {
      files.delete(path);
      mtimes.delete(path);
    },

    async readFile(path: string): Promise<FileRead> {
      reads.push(path);
      if (unreadable.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      const contents = files.get(path);
      return contents === undefined ? { kind: 'missing' } : { kind: 'read', contents };
    },

    /**
     * The same bounded read the real seam does, over the same bytes.
     *
     * Implemented rather than stubbed to return the whole file, because the
     * behaviour a caller has to get right is what happens when the cap bites:
     * the first partial line is gone and `truncated` is true. A fake that
     * always answered `truncated: false` would make every test above it a test
     * of the happy path only.
     */
    async readFileTail(path: string, maxBytes: number): Promise<TailRead> {
      if (unreadable.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      const contents = files.get(path);
      if (contents === undefined) return { kind: 'missing' };

      const bytes = Buffer.from(contents, 'utf8');
      if (bytes.byteLength <= maxBytes) return { kind: 'read', contents, truncated: false };

      const window = bytes.subarray(bytes.byteLength - maxBytes);
      const brk = window.indexOf(0x0a);
      return {
        kind: 'read',
        contents: brk === -1 ? '' : window.subarray(brk + 1).toString('utf8'),
        truncated: true,
      };
    },

    async stat(path: string): Promise<FileStatRead> {
      stats.push(path);
      if (unstatable.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };
      const contents = files.get(path);
      if (contents === undefined) return { kind: 'missing' };
      return {
        kind: 'read',
        size: Buffer.byteLength(contents, 'utf8'),
        mtimeMs: mtimes.get(path) ?? mtimeOf(contents),
      };
    },

    async listDirectory(path: string): Promise<DirectoryRead> {
      if (unreadable.has(path)) return { kind: 'failed', reason: `EACCES: ${path}` };

      const prefix = `${path}/`;
      const entries = new Map<string, DirectoryEntry>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const separator = rest.indexOf('/');
        const name = separator === -1 ? rest : rest.slice(0, separator);
        entries.set(name, { name, kind: separator === -1 ? 'file' : 'directory' });
      }

      if (entries.size === 0 && !empty.has(path)) return { kind: 'missing' };
      return { kind: 'read', entries: [...entries.values()] };
    },
  };
}

/**
 * A stand-in mtime that moves whenever the contents do.
 *
 * Derived from the bytes rather than fixed, so a test that rewrites a file
 * without naming a new mtime -- including the many that build a fresh fake
 * over a record they edit in place -- still sees the file change. A constant
 * would make a same-size rewrite look untouched, and a cache would serve the
 * old parse of it, which is a bug the fake would be causing rather than
 * catching.
 */
function mtimeOf(contents: string): number {
  return createHash('sha256').update(contents).digest().readUIntBE(0, 6);
}
