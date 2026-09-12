import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import type { FileWrite, GrantFileSystem } from './server-grants.js';
import { nodeStoreFileSystem } from './node-store-files.js';

/**
 * The real grants file, named in one place so tests never reach for a disk.
 *
 * The write is a temporary file and a rename, which is the whole reason this is
 * not `writeFile` on the path. A rename within a directory is atomic, so a
 * reader either sees the grants that were there before or the ones that are
 * there now -- never half of a file. Writing in place would mean a server whose
 * process died mid-write comes back to a grants file that does not parse, and
 * the rule for an unreadable grants file is that the server refuses to start:
 * one bad moment would become a machine that will not come up.
 *
 * The temporary file is in the same directory on purpose. A rename across
 * filesystems is not a rename, and `/tmp` is a different filesystem often
 * enough that the atomicity would be quietly lost on the machines least like
 * the one it was tested on.
 *
 * Reads are the store seam's, which already turns errno into a value.
 */
export const nodeGrantFileSystem: GrantFileSystem = {
  readFile: (path: string) => nodeStoreFileSystem.readFile(path),

  async writeFile(path: string, contents: string): Promise<FileWrite> {
    const temporary = join(dirname(path), `.${process.pid}.grants.tmp`);
    try {
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, path);
      return { kind: 'written' };
    } catch (error) {
      // The temporary is removed on the way out, and a failure to remove it is
      // not reported: what the caller needs to act on is that the grants were
      // not written, and a second sentence about a stray file would bury it.
      await unlink(temporary).catch(() => undefined);
      return { kind: 'failed', reason: String(error) };
    }
  },
};
