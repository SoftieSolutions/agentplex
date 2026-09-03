import { join } from 'node:path';
import { z } from 'zod';
import { storeIdSchema, type StoreDescriptor, type StoreId } from '@agentplex/protocol';
import type { IdGenerator } from '../shared/ids.js';

/**
 * Store identity: the file at the root of a store is the store's name.
 *
 * A session is `{ storeId, sessionId }`, so everything a hub knows about a
 * session hangs off an id that must survive the server restarting, the volume
 * being remounted somewhere else, and two servers mounting it at once. The
 * only thing all three have in common is the volume itself, so the id lives
 * there: mint it on first use, read it forever after. No machine identity,
 * no hostname, no path hash — a store copied to another disk keeps its
 * sessions, and a store mounted twice is one store.
 */

/** Minted at the store root. The name is on the wire in no frame; only the id is. */
export const STORE_FILE_NAME = 'agentplex-store.json';

/**
 * Non-strict on purpose: a later version may add fields, and an older server
 * that meets one of its files should read the id and carry on rather than
 * declare the store broken.
 */
const storeFileSchema = z.object({ storeId: storeIdSchema });

/**
 * The disk seam.
 *
 * Errno becomes a value here rather than an exception, for two reasons: the
 * rules below distinguish "no file yet" from "a file I cannot read" and must
 * not do that by matching on an error message, and a store that fails must
 * cost only itself — which it cannot do if resolving one can throw past the
 * loop over the others.
 */
export type FileRead =
  | { readonly kind: 'read'; readonly contents: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

export type FileCreate =
  | { readonly kind: 'created' }
  /** A file was already there. Not an error: it is the other server's mint. */
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface StoreFileSystem {
  readFile(path: string): Promise<FileRead>;
  /**
   * Creates a file only if none exists at that path, atomically. An
   * implementation that reads first and then writes is not one: that is the
   * race this exists to close.
   */
  createFile(path: string, contents: string): Promise<FileCreate>;
}

export interface StoreIdentityDependencies {
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
}

/**
 * What one configured store path turned out to be.
 *
 * A failure names the path and stays in the listing rather than being thrown,
 * so a caller can report the stores it has and say what happened to the rest.
 */
export type StoreIdentity =
  | {
      readonly ok: true;
      readonly store: StoreDescriptor;
      /** True when this call was the one that created the file. Log-worthy; nothing branches on it. */
      readonly minted: boolean;
    }
  | { readonly ok: false; readonly path: string; readonly problem: string };

export type StoreFileParse =
  | { readonly ok: true; readonly storeId: StoreId }
  | { readonly ok: false; readonly problem: string };

/** The parser that can say no. Every path into a `storeId` goes through it. */
export function parseStoreFile(contents: string): StoreFileParse {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false, problem: `${STORE_FILE_NAME} is not JSON: ${String(error)}` };
  }

  const parsed = storeFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, problem: `${STORE_FILE_NAME} is not a store file: ${issues}` };
  }

  return { ok: true, storeId: parsed.data.storeId };
}

/**
 * Reads a store's id, minting one the first time the store is used.
 *
 * A file that is there and unreadable is never minted over. Overwriting it
 * would hand the same directory a second identity, and every session the hub
 * has already filed under the first one would silently belong to nothing.
 * Refusing costs one store; clobbering costs the history of a store.
 */
export async function ensureStoreIdentity(
  path: string,
  { files, ids }: StoreIdentityDependencies,
): Promise<StoreIdentity> {
  const file = join(path, STORE_FILE_NAME);

  const existing = await readStoreIdentity(path, file, files);
  if (existing !== null) return existing;

  const minted = storeIdSchema.safeParse(ids.newId());
  if (!minted.success) {
    return { ok: false, path, problem: 'the id source produced no usable store id' };
  }

  const created = await files.createFile(file, serializeStoreFile(minted.data));
  if (created.kind === 'created') {
    return { ok: true, store: { storeId: minted.data, path }, minted: true };
  }
  if (created.kind === 'failed') {
    return { ok: false, path, problem: `cannot write ${STORE_FILE_NAME}: ${created.reason}` };
  }

  // Another server minted between our read and our create. Its file is the
  // store's identity now; the id we were about to write never existed.
  const winner = await readStoreIdentity(path, file, files);
  return (
    winner ?? {
      ok: false,
      path,
      problem: `${STORE_FILE_NAME} was created and then removed while reading it`,
    }
  );
}

/**
 * Resolves every configured store, keeping the order they were configured in.
 *
 * Concurrent because mounts are independent: one store on a wedged network
 * mount must not hold up the ones on local disks.
 */
export async function ensureStores(
  paths: readonly string[],
  dependencies: StoreIdentityDependencies,
): Promise<readonly StoreIdentity[]> {
  return Promise.all(paths.map((path) => ensureStoreIdentity(path, dependencies)));
}

/** `null` means there is no file yet, which is the one case that mints. */
async function readStoreIdentity(
  path: string,
  file: string,
  files: StoreFileSystem,
): Promise<StoreIdentity | null> {
  const read = await files.readFile(file);
  if (read.kind === 'missing') return null;
  if (read.kind === 'failed') {
    return { ok: false, path, problem: `cannot read ${STORE_FILE_NAME}: ${read.reason}` };
  }

  const parsed = parseStoreFile(read.contents);
  return parsed.ok
    ? { ok: true, store: { storeId: parsed.storeId, path }, minted: false }
    : { ok: false, path, problem: parsed.problem };
}

/** Indented with a trailing newline: this file gets opened by people. */
function serializeStoreFile(storeId: StoreId): string {
  return `${JSON.stringify({ storeId }, null, 2)}\n`;
}
