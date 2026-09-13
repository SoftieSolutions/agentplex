import { readdir, realpath, stat } from 'node:fs/promises';
import type { DirectoryEntry } from '@agentplex/protocol';
import type { DirectoryRead, DirectoryReader, RealPath } from './directory-browse.js';

/**
 * The real disk under the browse rule, named in one place so nothing below
 * `main` reaches for it.
 *
 * Two calls, and the choice of syscall in each is the whole of what this file
 * decides.
 *
 * `realPath` is `realpath` and then `stat`, in that order. `realpath` is what
 * resolves every link in the path, which is the only thing that can answer the
 * question containment actually asks -- "where does this end up" -- and the
 * `stat` afterwards is on the resolved path, so a link to a file and a file are
 * one answer rather than two. `ENOENT` and `ENOTDIR` become values rather than
 * an exception, because the rule above has to tell a path that is not there
 * from one this process may not read, and everything else is `failed` with
 * whatever the kernel said.
 *
 * `read` is `readdir` with `withFileTypes`, which is the one call that already
 * knows what each entry is: the kind comes back with the name, from the
 * directory entry itself, so a listing is one syscall rather than one `lstat`
 * per file. It is `lstat` semantics -- a `Dirent` describes the link and not
 * its target -- which is exactly what the rule wants, and is why a link is
 * reported as `other` here without this file having to decide not to follow it.
 *
 * `withFileTypes` is not guaranteed to know: on filesystems that do not carry a
 * type in the directory entry the runtime falls back, and an entry can still
 * come back as none of the three. `other` is what those are, which is honest
 * and is the same word a link gets -- both mean "not something to descend into
 * or open", which is all a picker needs.
 */
export const nodeDirectoryReader: DirectoryReader = {
  async realPath(path: string): Promise<RealPath> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      return { kind: 'failed', reason: String(error) };
    }

    try {
      const found = await stat(resolved);
      return found.isDirectory()
        ? { kind: 'directory', path: resolved }
        : { kind: 'not-a-directory' };
    } catch (error) {
      // It resolved a moment ago and will not stat now: a directory that was
      // removed between the two calls, or a mount that went away. `missing` is
      // the honest reading of both.
      return errorCode(error) === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async read(path: string): Promise<DirectoryRead> {
    try {
      const found = await readdir(path, { withFileTypes: true });
      const entries: DirectoryEntry[] = found.map((entry) => ({
        name: entry.name,
        // Links first, before the two questions that would be true of what they
        // point at. `Dirent` describes the link itself, so this is already the
        // answer; asking in the other order would still be right and would read
        // as though following one were an option.
        kind: entry.isSymbolicLink()
          ? 'other'
          : entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : 'other',
      }));
      return { kind: 'read', entries };
    } catch (error) {
      return { kind: 'failed', reason: String(error) };
    }
  },
};

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
