import { opendir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { DirectoryEntry } from '@agentplex/protocol';
import { errnoCode } from '@agentplex/node-shared';
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
 * `read` is `opendir`, walked one entry at a time and abandoned at `limit`.
 * `readdir` would be one call, and it would also be every entry of the
 * directory in memory at once before anything could be cut: a picker pointed at
 * a directory of a million files would cost the server a million `Dirent`s to
 * show a thousand. Walking stops at the entry past the limit, which is what
 * says `more` without reading a second one. The order is the kernel's, not the
 * name's, so what comes back above the cap is some `limit` of the entries and
 * not the first `limit` alphabetically; sorting is the caller's.
 *
 * Each `Dirent` already knows what its entry is: the kind comes back with the
 * name, from the directory entry itself, so a listing is not one `lstat` per
 * file. It is `lstat` semantics -- a `Dirent` describes the link and not its
 * target -- which is exactly what the rule wants, and is why a link is
 * reported as `other` here without this file having to decide not to follow it.
 *
 * A `Dirent` is not guaranteed to know: on filesystems that do not carry a type
 * in the directory entry the runtime falls back to an `lstat` of its own, and
 * an entry can still come back as none of the three. The cap bounds that
 * fallback as it bounds everything else. `other` is what those entries are,
 * which is honest and is the same word a link gets -- both mean "not something
 * to descend into or open", which is all a picker needs.
 */
export const nodeDirectoryReader: DirectoryReader = {
  async realPath(path: string): Promise<RealPath> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      const code = errnoCode(error);
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
      return errnoCode(error) === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'failed', reason: String(error) };
    }
  },

  async read(path: string, limit: number): Promise<DirectoryRead> {
    const entries: DirectoryEntry[] = [];
    let more = false;
    try {
      // Nothing awaited between the open and the loop. `for await` closes the
      // handle when it finishes, breaks or throws, and that is the only close
      // there is: a handle opened and then left behind by a throw before the
      // loop began would be a descriptor leaked per failed request. It is also
      // why there is no read after the break -- the handle is already closed.
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (entries.length === limit) {
          more = true;
          break;
        }
        entries.push({ name: entry.name, kind: kindOf(entry) });
      }
    } catch (error) {
      return { kind: 'failed', reason: String(error) };
    }
    return { kind: 'read', entries, more };
  },
};

/**
 * Links first, before the two questions that would be true of what they point
 * at. `Dirent` describes the link itself, so this is already the answer; asking
 * in the other order would still be right and would read as though following
 * one were an option.
 */
function kindOf(entry: Dirent): DirectoryEntry['kind'] {
  if (entry.isSymbolicLink()) return 'other';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}
