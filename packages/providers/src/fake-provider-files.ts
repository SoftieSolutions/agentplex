import type { FileRead } from './store-identity.js';
import type { DirectoryEntry, DirectoryRead, ProviderFiles, TailRead } from './provider-files.js';

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
}

export function createFakeProviderFiles(options: FakeProviderFilesOptions = {}): ProviderFiles {
  const files = new Map(Object.entries(options.files ?? {}));
  const unreadable = new Set(options.unreadable ?? []);
  const empty = new Set(options.directories ?? []);

  return {
    async readFile(path: string): Promise<FileRead> {
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
