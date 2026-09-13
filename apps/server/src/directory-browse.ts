import {
  DIRECTORY_ENTRIES_MAX,
  directorySchema,
  type DirectoryEntry,
  type RefusalCode,
} from '@agentplex/protocol';

/**
 * What a client may look at on this machine's disk, and the rule that decides.
 *
 * A project holds a directory on a server and the user picks it by browsing, so
 * a directory has to cross the wire. The v2 rule said no frame carries a cwd;
 * `packages/protocol/src/directory.ts` holds the amendment that lets this one,
 * and this file is the half of it that has teeth. The frame's parser proves the
 * value is an absolute, NUL-free path. It proves nothing about whose path it
 * is. That is decided here, against a list only the operator of this machine
 * can write, and a request that is not on it is refused with a sentence.
 *
 * ## Why the check is on the real path
 *
 * `/srv/work/..` parses, and it is `/`. A prefix test against the string would
 * pass it and a prefix test against a normalised string would still pass
 * `/srv/work/link-to-etc`, because the last segment of that is a symlink and no
 * amount of text processing can see through one. So the kernel is asked: the
 * requested directory is resolved to its real path, every root is resolved to
 * its real path, and containment is decided between the two answers. What that
 * costs is one `realpath` per root per request, which is a handful of syscalls
 * on a path a person walks by hand.
 *
 * ## Why a symlink is listed and never followed
 *
 * An entry that is a link is reported as `other`. It is not hidden -- a picker
 * that omitted entries would be one that cannot show what is actually there --
 * and it is not resolved, because resolving it is how a listing under a root
 * ends up showing what is outside one. Descending is still possible for the
 * user who genuinely wants it: the link's target is reachable the moment its
 * own root is configured, which is the operator making that decision rather
 * than the link making it for them.
 *
 * ## Two callers, one rule
 *
 * `allow` is the rule on its own: is this an existing directory under a root
 * this machine's operator configured? `list` is that answer plus a read. The
 * second caller is a session start carrying a project's directory, which needs
 * exactly the first half -- it is not listing anything, it is about to spawn
 * there -- and a start that reimplemented the containment test would be a
 * second answer to the question this file exists to answer once.
 *
 * `allow` answers the path as it was asked for, not as it resolved. What is
 * checked is the real path, because that is what the kernel will use; what is
 * handed back is the caller's own spelling, because that is the string the
 * session will report as its `cwd` and the string a project is keyed by. A
 * start that spawned in the resolved path would file every session behind a
 * symlink under no project at all.
 *
 * ## Why containment is checked and the entries are not
 *
 * Only the directory being listed is checked. The entries inside it are
 * whatever is inside it, and a listing that quietly dropped the ones that are
 * links pointing outside would be describing a directory that does not exist.
 * What bounds the damage is that an entry is only ever a name: to look *into*
 * one, a client sends another request, and that request is checked like every
 * other.
 */

/** The one directory a request names, or `null` for the roots themselves. */
export type BrowseRequest = string | null;

/**
 * The real path of something on this disk, or why there is not one.
 *
 * errno becomes a value rather than an exception, for the reason
 * `store-identity.ts` gives for its own seam: the rule above has to tell a path
 * that is not there from one this process may not read, and matching on the
 * text of an error is how that stops working on somebody else's locale.
 */
export type RealPath =
  | { readonly kind: 'directory'; readonly path: string }
  /** It resolved, and what is there is not a directory. */
  | { readonly kind: 'not-a-directory' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

/** What one directory holds, or why it could not be read. */
export type DirectoryRead =
  | { readonly kind: 'read'; readonly entries: readonly DirectoryEntry[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The disk, as this rule needs it: resolve a path, and read a directory.
 *
 * Two calls and no third. There is no `stat` of an entry here, deliberately:
 * what kind each entry is comes back with the read, from the one syscall that
 * already knows, so a listing cannot become one `lstat` per file on a directory
 * with ten thousand of them.
 */
export interface DirectoryReader {
  /** Resolves every link in the path and says what is at the end of it. */
  realPath(path: string): Promise<RealPath>;
  /**
   * The entries of a directory, unsorted, uncapped, links reported as links.
   *
   * Never followed: an implementation that resolved an entry would make the
   * kind on the frame a claim about somewhere else.
   */
  read(path: string): Promise<DirectoryRead>;
}

export interface DirectoryBrowseDependencies {
  /** The roots from configuration: absolute, deduplicated, possibly empty. */
  readonly roots: readonly string[];
  readonly reader: DirectoryReader;
}

export interface DirectoryListing {
  readonly ok: true;
  /** What was listed, echoed back, or `null` for the roots. */
  readonly directory: string | null;
  /** Every configured root, as configured. Never the resolved spelling. */
  readonly roots: readonly string[];
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export interface DirectoryRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  /** A sentence naming the path and what was wrong with it. Never an errno alone. */
  readonly problem: string;
}

export type DirectoryOutcome = DirectoryListing | DirectoryRefusal;

/** A directory this machine will act in, or why it will not. */
export type DirectoryAllowance =
  { readonly ok: true; readonly directory: string } | DirectoryRefusal;

/**
 * The containment rule alone: what a browse and a spawn both have to ask.
 *
 * Separate from the browser it is half of, so that a caller which must not be
 * able to read somebody's disk cannot: `session-control.ts` takes this and not
 * a `DirectoryBrowser`, and there is therefore no `list` reachable from a
 * session start.
 */
export interface DirectoryGuard {
  /** Whether this machine will act in that directory, and why not when it will not. */
  allow(directory: string): Promise<DirectoryAllowance>;
}

export interface DirectoryBrowser extends DirectoryGuard {
  list(directory: BrowseRequest): Promise<DirectoryOutcome>;
}

/**
 * The four refusals, each as its own sentence.
 *
 * Distinct messages rather than one "no", because they are four different
 * things for a person to do: configure a root, pick a path inside one, pick a
 * directory rather than a file, or fix a permission. A single message would
 * make every one of them read as the second.
 */
const NO_ROOTS =
  'this server has no browse roots configured, so it will not list any directory: ' +
  'set AGENTPLEX_BROWSE_ROOTS or pass --browse-root (an absolute path, repeatable)';

export function createDirectoryBrowser({
  roots,
  reader,
}: DirectoryBrowseDependencies): DirectoryBrowser {
  /**
   * The rule, once, for both verbs.
   *
   * The resolved path is kept beside the asked-for one because `list` needs it
   * -- reading the directory the kernel actually reaches is the only read that
   * describes what is there -- while everything said to the caller names the
   * path they asked about.
   */
  const resolve = async (
    directory: string,
  ): Promise<DirectoryRefusal | { readonly ok: true; readonly real: string }> => {
    if (roots.length === 0) return { ok: false, code: 'refused', problem: NO_ROOTS };

    // Parsed again here, and not because the frame's parser is in doubt. This
    // is a library function with one rule in it, and a caller that reached it
    // from somewhere other than a parsed frame -- a test, a later feature --
    // must not be the thing that decides whether `\0` is checked.
    if (!directorySchema.safeParse(directory).success) {
      return {
        ok: false,
        code: 'refused',
        problem: `${directory} is not an absolute path this server will open`,
      };
    }

    const asked = await reader.realPath(directory);
    if (asked.kind === 'missing') {
      return {
        ok: false,
        code: 'refused',
        problem: `there is nothing at ${directory} on this machine`,
      };
    }
    if (asked.kind === 'not-a-directory') {
      return { ok: false, code: 'refused', problem: `${directory} is not a directory` };
    }
    if (asked.kind === 'failed') {
      // Before containment, and that is the one ordering decision here that
      // could have gone the other way. A path this process cannot resolve is
      // a path it cannot place under a root either, so the honest answer is
      // that it could not look -- and saying "not under a root" instead would
      // be a claim nothing checked.
      return {
        ok: false,
        code: 'internal',
        problem: `this server could not resolve ${directory}: ${asked.reason}`,
      };
    }

    if (!(await contains(roots, asked.path, reader))) {
      // Named as the path the user asked for and not as the path it resolved
      // to. The second would tell whoever sent this where a link on this
      // machine points, which is a fact about a disk they were just refused.
      return {
        ok: false,
        code: 'refused',
        problem: `${directory} is not under a directory this server will browse`,
      };
    }

    return { ok: true, real: asked.path };
  };

  return {
    async allow(directory: string): Promise<DirectoryAllowance> {
      const resolved = await resolve(directory);
      return resolved.ok ? { ok: true, directory } : resolved;
    },

    async list(directory: BrowseRequest): Promise<DirectoryOutcome> {
      if (roots.length === 0) return { ok: false, code: 'refused', problem: NO_ROOTS };

      // The roots themselves, which is how a browse starts. They are answered
      // as configured rather than as resolved: the operator wrote these, they
      // are what every later refusal names, and a picker showing a user the
      // resolved spelling of their own home directory would be showing them a
      // path they never typed.
      if (directory === null) {
        return {
          ok: true,
          directory: null,
          roots,
          entries: roots.map((root) => ({ name: root, kind: 'directory' as const })),
          truncated: false,
        };
      }

      const resolved = await resolve(directory);
      if (!resolved.ok) return resolved;

      const read = await reader.read(resolved.real);
      if (read.kind === 'failed') {
        // `internal` and not `refused`: the rule said yes, this machine failed
        // on its own side, and a fixed permission makes the same request work.
        return {
          ok: false,
          code: 'internal',
          problem: `this server could not read ${directory}: ${read.reason}`,
        };
      }

      const sorted = [...read.entries].sort(byName);
      return {
        ok: true,
        directory,
        roots,
        entries: sorted.slice(0, DIRECTORY_ENTRIES_MAX),
        truncated: sorted.length > DIRECTORY_ENTRIES_MAX,
      };
    },
  };
}

/**
 * Whether a resolved path is one of the roots or sits inside one.
 *
 * The roots are resolved here rather than at construction, so that a root
 * created, moved or repointed after this server started is answered as it is
 * now. It is a handful of syscalls on a path a person walks by hand, and the
 * alternative is a server that has to be restarted to notice a mounted volume.
 *
 * A root that cannot be resolved costs itself and not the request: a machine
 * with three roots, one of them an unmounted volume, still browses the other
 * two. An unreadable item in a listing costs itself, not the listing.
 */
async function contains(
  roots: readonly string[],
  resolved: string,
  reader: DirectoryReader,
): Promise<boolean> {
  for (const root of roots) {
    const real = await reader.realPath(root);
    if (real.kind !== 'directory') continue;
    if (resolved === real.path) return true;
    // The separator is what makes this a containment test rather than a prefix
    // test: without it `/srv/work` contains `/srv/work-secrets`.
    if (resolved.startsWith(real.path.endsWith('/') ? real.path : `${real.path}/`)) return true;
  }
  return false;
}

/**
 * Sorted by name, by code unit.
 *
 * Not `localeCompare`: the order a listing comes back in has to be the same on
 * the server in the basement and the one in a container with no ICU data, and a
 * collation that depends on the machine's locale is a listing whose order
 * depends on where it ran.
 */
function byName(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}
