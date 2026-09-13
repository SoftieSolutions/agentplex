import type { DirectoryEntry } from '@agentplex/protocol';
import type { DirectoryRead, DirectoryReader, RealPath } from './directory-browse.js';

/**
 * A disk written down: directories, what is in them, and the links between
 * them.
 *
 * A real implementation of the seam rather than a mock, because what the browse
 * rule has to get right is what it does with a disk it did not expect -- a path
 * that resolves somewhere else, a root that is not mounted, a directory it may
 * not read. Each of those is a value here rather than a call somebody asserts
 * was made.
 *
 * Links are the reason this is a map of paths to targets rather than a tree.
 * The one property the rule exists to hold is that a link inside a root cannot
 * be used to leave it, and stating a link as "this path is really that path" is
 * the shortest way to write a disk where that is true.
 */
export interface FakeDirectoryReaderOptions {
  /** Each directory and the entries in it, by the path a caller would name. */
  readonly directories?: Readonly<Record<string, readonly DirectoryEntry[]>>;
  /**
   * Paths that resolve somewhere else: a link, and where it really goes.
   *
   * Applied to a whole path and to any prefix of one, the way `realpath` does:
   * with `/home/dev` linked to `/mnt/dev`, `/home/dev/code` resolves to
   * `/mnt/dev/code` whether or not anybody wrote that second line down.
   */
  readonly links?: Readonly<Record<string, string>>;
  /** Paths that exist and are not directories: a file, a socket. */
  readonly files?: readonly string[];
  /** Paths whose resolution fails, and what the kernel said. */
  readonly unresolvable?: Readonly<Record<string, string>>;
  /** Directories that resolve and cannot be read, and why. */
  readonly unreadable?: Readonly<Record<string, string>>;
}

export interface FakeDirectoryReader extends DirectoryReader {
  /** Every path `realPath` was asked about, in order. */
  readonly resolved: readonly string[];
  /** Every path `read` was asked about, in order. */
  readonly reads: readonly string[];
}

export function createFakeDirectoryReader(
  options: FakeDirectoryReaderOptions = {},
): FakeDirectoryReader {
  const directories = options.directories ?? {};
  const links = options.links ?? {};
  const files = new Set(options.files ?? []);
  const unresolvable = options.unresolvable ?? {};
  const unreadable = options.unreadable ?? {};

  const resolved: string[] = [];
  const reads: string[] = [];

  return {
    async realPath(path: string): Promise<RealPath> {
      resolved.push(path);
      const failure = unresolvable[path];
      if (failure !== undefined) return { kind: 'failed', reason: failure };

      const real = follow(normalize(path), links);
      if (files.has(real)) return { kind: 'not-a-directory' };
      if (!(real in directories)) return { kind: 'missing' };
      return { kind: 'directory', path: real };
    },

    async read(path: string): Promise<DirectoryRead> {
      reads.push(path);
      const problem = unreadable[path];
      if (problem !== undefined) return { kind: 'failed', reason: problem };
      const entries = directories[path];
      if (entries === undefined) return { kind: 'failed', reason: 'ENOENT: no such directory' };
      return { kind: 'read', entries };
    },

    get resolved(): readonly string[] {
      return resolved;
    },

    get reads(): readonly string[] {
      return reads;
    },
  };
}

/**
 * `..`, `.` and a trailing separator collapsed, the way `realpath` collapses
 * them before it looks at anything.
 *
 * Written here rather than taken from `node:path` so that the fake answers the
 * same on every platform the suite runs on, and so that the one case the rule
 * cares about -- `/srv/work/..` being `/`, not a directory under `/srv/work` --
 * is visible in the fake rather than delegated.
 */
function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Every link on the path, longest prefix first, until nothing more resolves. */
function follow(path: string, links: Readonly<Record<string, string>>): string {
  let current = path;
  for (let hop = 0; hop < 16; hop += 1) {
    const matched = Object.keys(links)
      .filter((from) => current === from || current.startsWith(`${from}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (matched === undefined) return current;
    const target = links[matched];
    if (target === undefined) return current;
    current = normalize(`${target}${current.slice(matched.length)}`);
  }
  return current;
}
