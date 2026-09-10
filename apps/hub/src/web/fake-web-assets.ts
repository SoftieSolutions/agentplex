import type { WebAssetFileSystem } from './web-assets.js';

/**
 * A web root in memory.
 *
 * The disk is the whole of what static serving is about, so the tests get a
 * real implementation of the seam rather than a mock: files that are there,
 * files that are not, and the one failure that is neither — a file that exists
 * and cannot be read, which must never be reported as absence.
 *
 * The default is an empty root, because that is the state this hub has to
 * survive: a service running with no client build beside it.
 */
export interface FakeWebAssetsOptions {
  /** What is on the volume, as `path relative to the root -> contents`. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths whose read fails for a reason that is not absence: a mode bit, a directory. */
  readonly unreadable?: readonly string[];
  /** Where these files would be, for the log line the hub writes at startup. */
  readonly root?: string;
}

export interface FakeWebAssets extends WebAssetFileSystem {
  /** Every path a read was attempted at, in order, so a test can assert on none. */
  readonly reads: readonly string[];
}

export function createFakeWebAssets(options: FakeWebAssetsOptions = {}): FakeWebAssets {
  const files = new Map(Object.entries(options.files ?? {}));
  const unreadable = new Set(options.unreadable ?? []);
  const reads: string[] = [];
  const encoder = new TextEncoder();

  return {
    root: options.root ?? '/app/apps/web/dist',
    reads,
    read: async (file) => {
      reads.push(file);
      if (unreadable.has(file)) throw new Error(`EACCES: ${file}`);
      const contents = files.get(file);
      return contents === undefined ? null : encoder.encode(contents);
    },
  };
}
