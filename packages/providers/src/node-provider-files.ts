import { open, readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileRead } from './store-identity.js';
import type { DirectoryEntry, DirectoryRead, ProviderFiles, TailRead } from './provider-files.js';

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

  async readFileTail(path: string, maxBytes: number): Promise<TailRead> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      return missingOrFailed(error);
    }

    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        // Small enough to be the whole answer. Read as a string, so a file of
        // exactly this size comes back identical to what `readFile` would have
        // given -- there is no window to have landed inside.
        const contents = await handle.readFile('utf8');
        return { kind: 'read', contents, truncated: false };
      }

      // Past the cap, so only the window is read: the point of the method is
      // that a multi-megabyte transcript never becomes a multi-megabyte string
      // in this process.
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, size - maxBytes);
      return {
        kind: 'read',
        contents: fromFirstWholeLine(buffer.subarray(0, bytesRead)),
        truncated: true,
      };
    } catch (error) {
      return missingOrFailed(error);
    } finally {
      await handle.close();
    }
  },
};

/**
 * The window from its first line break onwards, decoded.
 *
 * Sliced as bytes and only then decoded, which is the order that matters: the
 * window begins at an arbitrary byte offset, so its first character may be the
 * tail of a multi-byte sequence, and decoding first would turn that into a
 * replacement character sitting in front of a line no parser should have been
 * handed anyway. A line break is ASCII in UTF-8 and cannot appear inside a
 * multi-byte sequence, so searching the bytes for one is exact.
 *
 * A window with no line break in it yields the empty string. That is a file
 * whose last line alone is larger than the cap, and half a line is not a line:
 * the caller is told nothing could be read and that there is more behind it,
 * which is the direction that does not over-claim.
 */
function fromFirstWholeLine(window: Buffer): string {
  const brk = window.indexOf(0x0a);
  return brk === -1 ? '' : window.subarray(brk + 1).toString('utf8');
}

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
