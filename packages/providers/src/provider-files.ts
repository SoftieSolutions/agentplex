import type { FileRead } from './store-identity.js';

/**
 * The read-only view of a store that an adapter gets.
 *
 * Read-only is the point. A provider's own state directory belongs to the
 * provider, and agentplex writing into it is how a v1 bug corrupted a session
 * list that had nothing wrong with it. An adapter that is never handed a write
 * cannot make that mistake, and a reviewer can see it cannot from the type.
 *
 * `FileRead` is the store-identity vocabulary, reused deliberately: "missing"
 * and "failed" have to stay distinguishable all the way down, because a
 * provider that is simply absent from a store is normal and a directory that
 * cannot be listed is not.
 */
export interface ProviderFiles {
  readFile(path: string): Promise<FileRead>;
  listDirectory(path: string): Promise<DirectoryRead>;
  /**
   * The last `maxBytes` bytes of a file, whole lines only.
   *
   * Beside `readFile` rather than replacing it, because the two answer
   * different questions. Discovery reads a whole transcript because it needs
   * the running token total, which is a sum over every line; reading one
   * session's transcript for a screen needs the end of it, and a real Claude
   * Code transcript is routinely several megabytes. `readFile` has no cap at
   * all, so a caller that wanted a bounded read had nothing to ask for and the
   * only honest alternative was refusing large files outright -- which refuses
   * exactly the busy sessions somebody is looking at.
   *
   * Whole lines, because the formats above this are JSONL and a byte offset
   * lands in the middle of one. The partial first line is dropped here rather
   * than by every caller, which also disposes of a decoding hazard: a cut
   * inside a multi-byte character would otherwise reach a parser as a
   * replacement character it has no rule for.
   *
   * `truncated` is the half a caller cannot work out for itself, and it is what
   * lets a screen say "there is more behind this" rather than presenting the
   * tail as the whole.
   */
  readFileTail(path: string, maxBytes: number): Promise<TailRead>;
  /**
   * A file's size in bytes and its mtime, without reading it.
   *
   * What lets a discovery scan skip a transcript that has not changed since
   * the last one. Nearly every transcript in a store is finished, and a scan
   * runs on every report: reading and parsing all of them each time was the
   * whole cost of a scan, spent on files whose answer was already known.
   */
  stat(path: string): Promise<FileStatRead>;
}

/**
 * A file's size and mtime, or why there are none.
 *
 * The same three kinds `FileRead` has, for the same reason: a transcript
 * deleted between a listing and its stat is not a fault, and one that will not
 * be looked at is.
 */
export type FileStatRead =
  | { readonly kind: 'read'; readonly size: number; readonly mtimeMs: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The end of a file, and whether it was the whole of it.
 *
 * The same three kinds `FileRead` has, for the reason that vocabulary is
 * reused everywhere else: a file that is not there and a file that would not be
 * read have to stay distinguishable all the way down. What it adds is the one
 * fact a bounded read produces and an unbounded one cannot.
 */
export type TailRead =
  | { readonly kind: 'read'; readonly contents: string; readonly truncated: boolean }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface DirectoryEntry {
  /** The entry's own name, not its path: the caller knows the directory it asked about. */
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

export type DirectoryRead =
  | { readonly kind: 'read'; readonly entries: readonly DirectoryEntry[] }
  /** No such directory. For a provider adapter this means "not in this store", not an error. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };
