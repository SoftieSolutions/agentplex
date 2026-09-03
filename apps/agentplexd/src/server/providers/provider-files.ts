import type { FileRead } from '../store-identity.js';

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
}

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
