import type { ProviderFiles } from './provider-files.js';

/**
 * What a discovery scan remembers about a file between one scan and the next.
 *
 * Discovery runs on every report and every resume, and before this each run
 * read and parsed every transcript in the store whole. A store that has been
 * used for a while holds hundreds of them, several megabytes each, and almost
 * none of them changed since the last scan. So a scan stats a file first and
 * asks this cache for its parse: the same size and mtime as last time is the
 * same file, and the parse it produced last time is the answer.
 *
 * Keyed by `(size, mtimeMs)` rather than by either alone. Size alone misses a
 * rewrite of the same length; mtime alone misses nothing on a filesystem that
 * keeps it, but some round it to a second or worse, and an append inside that
 * second still moves the size. Any difference at all is a reload, and the
 * reload is the whole file. Parsing only the appended bytes would mean keeping
 * each parser's running state between scans, and first telling an append from
 * a truncation or a rewrite, which a stamp cannot do; the one file that changed
 * is a small cost beside the hundreds that did not.
 *
 * The caller stats before it loads, and the order matters. Read-then-stat
 * could file old contents under a newer stamp, and that stamp would match on
 * every scan after it for as long as the file stayed still. Stat-then-read can
 * only file newer contents under an older stamp, which the next scan sees as a
 * change and reloads.
 */
export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ScanCacheOptions<T> {
  /**
   * Whether a loaded value may be remembered. Everything is, unless this says
   * otherwise.
   *
   * A read that failed is the thing to leave out: it is a fact about the
   * moment, not about the file at that stamp, and fixing a permission touches
   * neither the size nor the mtime. A remembered failure would outlive its
   * cause for as long as nobody wrote to the file.
   */
  readonly keep?: (value: T) => boolean;
}

export interface ScanCache<T> {
  /**
   * The value for `path` as it stands at `stamp`: remembered if the stamp
   * matches the one it was loaded at, otherwise loaded now and remembered.
   */
  resolve(path: string, stamp: FileStamp, load: () => Promise<T>): Promise<T>;
  /**
   * Forget every path not in `seen`: the files this scan found. A transcript
   * that was deleted takes its entry with it, so the cache is never larger
   * than the store it describes.
   */
  retain(seen: ReadonlySet<string>): void;
}

interface Entry<T> {
  readonly stamp: FileStamp;
  readonly value: T;
}

export function createScanCache<T>(options: ScanCacheOptions<T> = {}): ScanCache<T> {
  const entries = new Map<string, Entry<T>>();
  const keep = options.keep ?? (() => true);

  return {
    async resolve(path, stamp, load) {
      const known = entries.get(path);
      if (known !== undefined && sameStamp(known.stamp, stamp)) return known.value;

      const value = await load();
      if (keep(value)) {
        entries.set(path, { stamp: { size: stamp.size, mtimeMs: stamp.mtimeMs }, value });
      } else {
        entries.delete(path);
      }
      return value;
    },

    retain(seen) {
      for (const path of entries.keys()) {
        if (!seen.has(path)) entries.delete(path);
      }
    },
  };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * A transcript as one scan found it: parsed, gone, or refusing to be looked at.
 *
 * The three kinds `FileRead` has, with the contents replaced by what the
 * provider's parser made of them. Only `parsed` is ever remembered; see
 * `ScanCacheOptions.keep` for why a failure is not.
 */
export type ScannedTranscript<P> =
  | { readonly kind: 'parsed'; readonly parse: P }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface TranscriptCacheDependencies<P> {
  readonly files: ProviderFiles;
  /**
   * The provider's parser. Whatever it answers is remembered, a `no-turns` or
   * `damaged` parse as much as a good one: each is a fact about the bytes, and
   * the caller reports a damaged file again on every scan from the parse it
   * gets back rather than from a read.
   */
  readonly parse: (contents: string) => P;
}

/**
 * One adapter's remembered transcripts, kept per store.
 *
 * Per store because the adapter is not. `registeredProviders` builds one of
 * each at boot and every store on the server is discovered through it, so a
 * single cache that forgot whatever one scan did not see would have a scan of
 * store B forget all of store A.
 */
export interface TranscriptCache<P> {
  /** Start a scan of the store at `storePath`. */
  scan(storePath: string): TranscriptScan<P>;
}

export interface TranscriptScan<P> {
  /**
   * The transcript at `path`: stat'ed, and read and parsed only if the stamp
   * differs from the one its remembered parse was taken at.
   */
  read(path: string): Promise<ScannedTranscript<P>>;
  /**
   * Forget every transcript of this store the scan did not find. Called once
   * the whole store has been walked; a scan that stops early simply keeps
   * what it had, which costs memory and never a wrong answer.
   */
  finish(): void;
}

export function createTranscriptCache<P>({
  files,
  parse,
}: TranscriptCacheDependencies<P>): TranscriptCache<P> {
  const stores = new Map<string, ScanCache<ScannedTranscript<P>>>();

  return {
    scan(storePath) {
      let cache = stores.get(storePath);
      if (cache === undefined) {
        cache = createScanCache<ScannedTranscript<P>>({ keep: (found) => found.kind === 'parsed' });
        stores.set(storePath, cache);
      }
      const store = cache;
      const seen = new Set<string>();

      return {
        async read(path) {
          // Stat first: see the note at the top of this file.
          const stamp = await files.stat(path);
          if (stamp.kind !== 'read') return stamp;
          seen.add(path);

          return await store.resolve(path, stamp, async () => {
            const read = await files.readFile(path);
            return read.kind === 'read' ? { kind: 'parsed', parse: parse(read.contents) } : read;
          });
        },

        finish() {
          store.retain(seen);
        },
      };
    },
  };
}
