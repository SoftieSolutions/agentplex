import { createFakeInstallationFiles } from './fake-installation-files.js';
import type { FakeInstallationFilesOptions } from './fake-installation-files.js';
import type { FileOutcome, WriteFileOptions, WriteMachine } from './write-machine.js';
import type { ManifestRead, ManifestReader, ManifestSource } from '../versions/version-check.js';

/**
 * A machine a test writes down, and everything it was asked to do to it.
 *
 * A real implementation of the seam rather than a mock, like every other fake
 * here. What matters about an update or an install is the order things happened
 * in and what was left behind -- the runtime moved before the packages, the
 * command's own package last, a prefix with a stamp in it afterwards -- and all
 * of those are values in this object.
 *
 * It extends the read-only fake rather than copying it, so a test describes
 * a prefix the same way `status`'s suites do.
 */
export interface FakeWriteMachineOptions extends FakeInstallationFilesOptions {
  /** Paths a directory cannot be made at, or a file written to, by the reason. */
  readonly unwritable?: Readonly<Record<string, string>>;
  /**
   * Paths that will not be removed while something is there, by the reason. A
   * path with nothing at it is removed, as the seam promises.
   */
  readonly unremovable?: Readonly<Record<string, string>>;
  /**
   * Renames that are refused, keyed `<from> -> <to>`, by the reason. Asked
   * before `unwritable`, for a move whose destination is fine on its own.
   */
  readonly refusedRenames?: Readonly<Record<string, string>>;
  /** What a downloaded file hashes to, by path. Anything else hashes to nothing. */
  readonly hashes?: Readonly<Record<string, string>>;
  /** `null` for a machine that will not give this run a temporary directory. */
  readonly temporary?: string | null;
  /**
   * A list every act is also appended to, for a test that has to order what
   * happened to the disk against what else happened -- a child started, a file
   * downloaded -- rather than against the other acts alone.
   */
  readonly journal?: string[];
}

export interface FakeWriteMachine extends WriteMachine {
  /** Every path written, made, removed, renamed, chmodded and linked, in order. */
  readonly acts: readonly string[];
  /** The links this run made, by path, to what each points at. */
  readonly links: ReadonlyMap<string, string>;
  /** What is on the disk now, for reading back what this run wrote. */
  readonly contents: ReadonlyMap<string, string>;
  /** The permission bits of every file this run created with one, or chmodded. */
  readonly modes: ReadonlyMap<string, number>;
}

export function createFakeWriteMachine(options: FakeWriteMachineOptions = {}): FakeWriteMachine {
  const reads = createFakeInstallationFiles(options);
  const contents = new Map(Object.entries(options.files ?? {}));
  const directories = new Set<string>();
  const unwritable = new Map(Object.entries(options.unwritable ?? {}));
  const unremovable = new Map(Object.entries(options.unremovable ?? {}));
  const refusedRenames = new Map(Object.entries(options.refusedRenames ?? {}));
  const hashes = new Map(Object.entries(options.hashes ?? {}));
  const recorded: string[] = [];
  const acts = {
    push(act: string): void {
      recorded.push(act);
      options.journal?.push(act);
    },
  };
  const links = new Map<string, string>();
  const modes = new Map<string, number>();

  const refusal = (table: ReadonlyMap<string, string>, path: string): string | undefined =>
    table.get(path);
  const holds = (path: string): boolean =>
    directories.has(path) ||
    [...contents.keys()].some((held) => held === path || held.startsWith(`${path}/`));

  const somethingAt = async (path: string): Promise<boolean> =>
    holds(path) || links.has(path) || (await reads.isFile(path));

  return {
    acts: recorded,
    links,
    contents,
    modes,

    // Reads see what the test described *and* what this run has written, so a
    // stamp written by the swap is a stamp a later read finds -- which is how a
    // test asserts that the prefix was left with a complete runtime in it.
    async readFile(path: string) {
      const written = contents.get(path);
      return written === undefined ? reads.readFile(path) : { kind: 'read', contents: written };
    },
    async isFile(path: string) {
      return contents.has(path) || (await reads.isFile(path));
    },

    async temporaryDirectory(): Promise<string | null> {
      return options.temporary === undefined ? '/tmp/agentplex-update' : options.temporary;
    },

    async makeDirectory(path: string): Promise<FileOutcome> {
      acts.push(`mkdir ${path}`);
      const problem = refusal(unwritable, path);
      if (problem !== undefined) return { ok: false, problem };
      directories.add(path);
      return { ok: true };
    },

    async removeDirectory(path: string): Promise<FileOutcome> {
      acts.push(`rm ${path}`);
      const problem = holds(path) ? refusal(unremovable, path) : undefined;
      if (problem !== undefined) return { ok: false, problem };
      for (const held of [...directories]) {
        if (held === path || held.startsWith(`${path}/`)) directories.delete(held);
      }
      for (const held of [...contents.keys()]) {
        if (held === path || held.startsWith(`${path}/`)) contents.delete(held);
      }
      return { ok: true };
    },

    async rename(from: string, to: string): Promise<FileOutcome> {
      acts.push(`mv ${from} ${to}`);
      const problem = refusedRenames.get(`${from} -> ${to}`) ?? refusal(unwritable, to);
      if (problem !== undefined) return { ok: false, problem };
      // A real rename onto a directory with something in it is refused, and a
      // fake that merged instead would pass a swap that forgot to clear it.
      if ([...contents.keys()].some((held) => held === to || held.startsWith(`${to}/`))) {
        return {
          ok: false,
          problem: `ENOTEMPTY: directory not empty, rename '${from}' -> '${to}'`,
        };
      }
      for (const [held, text] of [...contents.entries()]) {
        if (held === from || held.startsWith(`${from}/`)) {
          contents.delete(held);
          contents.set(`${to}${held.slice(from.length)}`, text);
        }
      }
      for (const held of [...directories]) {
        if (held === from || held.startsWith(`${from}/`)) {
          directories.delete(held);
          directories.add(`${to}${held.slice(from.length)}`);
        }
      }
      return { ok: true };
    },

    exists: somethingAt,

    async chmod(path: string, mode: number): Promise<FileOutcome> {
      acts.push(`chmod ${mode.toString(8).padStart(4, '0')} ${path}`);
      const problem = refusal(unwritable, path);
      if (problem !== undefined) return { ok: false, problem };
      modes.set(path, mode);
      return { ok: true };
    },

    async link(target: string, path: string): Promise<FileOutcome> {
      acts.push(`link ${target} ${path}`);
      const problem = refusal(unwritable, path);
      if (problem !== undefined) return { ok: false, problem };
      links.set(path, target);
      return { ok: true };
    },

    async writeFile(path: string, text: string, written?: WriteFileOptions): Promise<FileOutcome> {
      acts.push(`write ${path}`);
      const problem = refusal(unwritable, path);
      if (problem !== undefined) return { ok: false, problem };
      // Only a file this creates gets the mode, as the real one only sets it
      // on creation.
      if (written?.mode !== undefined && !(await somethingAt(path))) modes.set(path, written.mode);
      contents.set(path, text);
      return { ok: true };
    },

    async sha256(path: string): Promise<string | null> {
      return hashes.get(path) ?? null;
    },
  };
}

/**
 * The network as a lookup table: a URL or a path, and what is served at it.
 *
 * The seam a test replaces to have an unreachable manifest, a manifest that is
 * not one, and a release that says something -- none of which can be arranged
 * against a real github.com, and the first of which cannot be arranged at all.
 */
export interface FakeNetworkOptions {
  /** What each source answers with, by URL or by path. */
  readonly served?: Readonly<Record<string, string>>;
  /** What a source that is not served says. Unreachable, by default. */
  readonly problem?: string;
  /** Files the downloader writes, by URL: the path it would land at is recorded. */
  readonly downloadable?: readonly string[];
}

export interface FakeNetwork extends ManifestReader {
  download(url: string, path: string): Promise<FileOutcome>;
  /** Every source read and every URL downloaded, in order. */
  readonly requests: readonly string[];
}

export function createFakeNetwork(options: FakeNetworkOptions = {}): FakeNetwork {
  const served = new Map(Object.entries(options.served ?? {}));
  const downloadable = new Set(options.downloadable ?? []);
  const requests: string[] = [];

  return {
    requests,

    async read(source: ManifestSource): Promise<ManifestRead> {
      const where = source.kind === 'file' ? source.path : source.url;
      requests.push(where);
      const text = served.get(where);
      return text === undefined
        ? { kind: 'failed', problem: options.problem ?? `${where} could not be reached` }
        : { kind: 'read', text };
    },

    async download(url: string, path: string): Promise<FileOutcome> {
      requests.push(`download ${url} -> ${path}`);
      return downloadable.has(url)
        ? { ok: true }
        : { ok: false, problem: options.problem ?? `${url} could not be reached` };
    },
  };
}
