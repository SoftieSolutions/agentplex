import { createFakeInstallationFiles } from '../../installation/fake-installation-files.js';
import type { FakeInstallationFilesOptions } from '../../installation/fake-installation-files.js';
import type { FileOutcome, UpdateMachine } from './update-machine.js';
import type { ManifestRead, ManifestReader, ManifestSource } from '../../versions/version-check.js';

/**
 * A machine a test writes down, and everything it was asked to do to it.
 *
 * A real implementation of the seam rather than a mock, like every other fake
 * here. What matters about an update is the order things happened in and what
 * was left behind -- the runtime moved before the packages, the command's own
 * package last, a prefix with a stamp in it afterwards -- and all of those are
 * values in this object.
 *
 * It extends the read-only fake rather than restating it, so a test describes
 * a prefix the same way `status`'s suites do.
 */
export interface FakeUpdateMachineOptions extends FakeInstallationFilesOptions {
  /** Paths a directory cannot be made at, or a file written to, by the reason. */
  readonly unwritable?: Readonly<Record<string, string>>;
  /** Paths that will not be removed, by the reason. */
  readonly unremovable?: Readonly<Record<string, string>>;
  /** What a downloaded file hashes to, by path. Anything else hashes to nothing. */
  readonly hashes?: Readonly<Record<string, string>>;
  /** `null` for a machine that will not give this run a temporary directory. */
  readonly temporary?: string | null;
  /** What whoever is at this machine says, or nothing for a machine with nobody at it. */
  readonly answer?: 'yes' | 'no';
}

export interface FakeUpdateMachine extends UpdateMachine {
  /** Every path written, made, removed and renamed, in the order it happened. */
  readonly acts: readonly string[];
  /** What is on the disk now, for reading back what this run wrote. */
  readonly contents: ReadonlyMap<string, string>;
  /** Every question put to a person, in order. */
  readonly questions: readonly string[];
}

export function createFakeUpdateMachine(options: FakeUpdateMachineOptions = {}): FakeUpdateMachine {
  const reads = createFakeInstallationFiles(options);
  const contents = new Map(Object.entries(options.files ?? {}));
  const directories = new Set<string>();
  const unwritable = new Map(Object.entries(options.unwritable ?? {}));
  const unremovable = new Map(Object.entries(options.unremovable ?? {}));
  const hashes = new Map(Object.entries(options.hashes ?? {}));
  const acts: string[] = [];
  const questions: string[] = [];

  const refusal = (table: ReadonlyMap<string, string>, path: string): string | undefined =>
    table.get(path);

  return {
    acts,
    contents,
    questions,

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
      const problem = refusal(unremovable, path);
      if (problem !== undefined) return { ok: false, problem };
      directories.delete(path);
      for (const held of [...contents.keys()]) {
        if (held === path || held.startsWith(`${path}/`)) contents.delete(held);
      }
      return { ok: true };
    },

    async rename(from: string, to: string): Promise<FileOutcome> {
      acts.push(`mv ${from} ${to}`);
      const problem = refusal(unwritable, to);
      if (problem !== undefined) return { ok: false, problem };
      for (const [held, text] of [...contents.entries()]) {
        if (held === from || held.startsWith(`${from}/`)) {
          contents.delete(held);
          contents.set(`${to}${held.slice(from.length)}`, text);
        }
      }
      return { ok: true };
    },

    async writeFile(path: string, text: string): Promise<FileOutcome> {
      acts.push(`write ${path}`);
      const problem = refusal(unwritable, path);
      if (problem !== undefined) return { ok: false, problem };
      contents.set(path, text);
      return { ok: true };
    },

    async sha256(path: string): Promise<string | null> {
      return hashes.get(path) ?? null;
    },

    async askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'> {
      questions.push(question);
      return options.answer ?? 'nobody';
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
