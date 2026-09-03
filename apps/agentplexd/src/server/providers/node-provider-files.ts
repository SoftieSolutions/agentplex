import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileRead } from '../store-identity.js';
import type { DirectoryEntry, DirectoryRead, ProviderFiles } from './provider-files.js';

/**
 * The real store volume as an adapter sees it: reads and listings, no writes.
 *
 * AGX-16 shipped this seam without an implementation because nothing read a
 * disk yet. The Claude adapter is what needs one, and it needs exactly the
 * behaviour `nodeStoreFileSystem` already has for store identity: errno
 * becomes a value, and "there is no such directory" stays distinguishable from
 * "I could not read that directory". A provider that is simply absent from a
 * store is the normal case and must cost nothing; a mount that is refusing to
 * be read is a fault a user has to be told about, and the two are the same
 * exception object until somebody looks at `code`.
 *
 * There is no write here and there is no path to one. That is the seam doing
 * its job: a provider's state directory belongs to the provider.
 */
export const nodeProviderFiles: ProviderFiles = {
  async readFile(path: string): Promise<FileRead> {
    try {
      return { kind: 'read', contents: await readFile(path, 'utf8') };
    } catch (error) {
      return missingOrFailed(error);
    }
  },

  async listDirectory(path: string): Promise<DirectoryRead> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return { kind: 'read', entries: entries.map(describe) };
    } catch (error) {
      // ENOTDIR joins ENOENT: a plain file where a provider's directory should
      // be is that provider not being in this store, not a broken store.
      return missingOrFailed(error, 'ENOTDIR');
    }
  },
};

/**
 * The entry's kind, resolved without following it anywhere.
 *
 * A symlink is reported as `other` rather than followed. Discovery walks a
 * directory somebody else writes into, and a link is the cheapest way to point
 * it at a file outside the store or into a cycle; a provider that wants its
 * transcripts found can put them where it says they are.
 */
function describe(entry: Dirent): DirectoryEntry {
  if (entry.isFile()) return { name: entry.name, kind: 'file' };
  if (entry.isDirectory()) return { name: entry.name, kind: 'directory' };
  return { name: entry.name, kind: 'other' };
}

function missingOrFailed(
  error: unknown,
  ...alsoMissing: readonly string[]
): { kind: 'missing' } | { kind: 'failed'; reason: string } {
  const code = errorCode(error);
  return code === 'ENOENT' || (code !== undefined && alsoMissing.includes(code))
    ? { kind: 'missing' }
    : { kind: 'failed', reason: String(error) };
}

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
