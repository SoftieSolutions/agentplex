import type { FileRead } from './store-identity.js';
import type { FileWrite, GrantFileSystem } from './server-grants.js';

export interface FakeGrantFilesOptions {
  /** What is on this disk to begin with, by path. */
  readonly contents?: Readonly<Record<string, string>>;
  /** Paths whose read fails rather than coming back missing. */
  readonly unreadable?: readonly string[];
  /** Paths whose write fails. How a caller's degrade path gets exercised. */
  readonly unwritable?: readonly string[];
}

export interface FakeGrantFiles extends GrantFileSystem {
  /** What is on the disk now, so a test asserts on the file rather than a mock. */
  written(path: string): string | undefined;
  /** How many times each path was written. A handshake that records twice is a bug. */
  writes(path: string): number;
  /**
   * Makes a path stop answering, or start again.
   *
   * A disk that fails *after* a server is up is a different case from one that
   * was failing when it started, and it is the one the degrade paths are for: a
   * grants file that cannot be read under a running server, a record of a
   * handshake that cannot be written. Both need a fake that can change its mind.
   */
  breaks(path: string, how: { readonly reads?: boolean; readonly writes?: boolean }): void;
}

/**
 * A grants file on a disk a test wrote down.
 *
 * It stores the serialized text rather than parsed records, so a test that
 * asserts on what was stored is asserting on the bytes a real server would have
 * written -- including, crucially, that a token is not among them.
 */
export function createFakeGrantFiles(options: FakeGrantFilesOptions = {}): FakeGrantFiles {
  const disk = new Map<string, string>(Object.entries(options.contents ?? {}));
  const unreadable = new Set(options.unreadable ?? []);
  const unwritable = new Set(options.unwritable ?? []);
  const counts = new Map<string, number>();

  return {
    readFile(path: string): Promise<FileRead> {
      if (unreadable.has(path)) {
        return Promise.resolve({ kind: 'failed', reason: 'a disk a test made unreadable' });
      }
      const contents = disk.get(path);
      return Promise.resolve(
        contents === undefined ? { kind: 'missing' } : { kind: 'read', contents },
      );
    },

    writeFile(path: string, contents: string): Promise<FileWrite> {
      if (unwritable.has(path)) {
        return Promise.resolve({ kind: 'failed', reason: 'a disk a test made unwritable' });
      }
      disk.set(path, contents);
      counts.set(path, (counts.get(path) ?? 0) + 1);
      return Promise.resolve({ kind: 'written' });
    },

    written: (path: string) => disk.get(path),
    writes: (path: string) => counts.get(path) ?? 0,

    breaks(path: string, how: { readonly reads?: boolean; readonly writes?: boolean }): void {
      if (how.reads !== undefined)
        void (how.reads ? unreadable.add(path) : unreadable.delete(path));
      if (how.writes !== undefined)
        void (how.writes ? unwritable.add(path) : unwritable.delete(path));
    },
  };
}
