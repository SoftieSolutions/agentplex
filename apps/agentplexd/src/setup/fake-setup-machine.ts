import type { DirectoryMade, SetupMachine } from './setup-machine.js';

/**
 * A machine written down: a home directory, a PATH, and what is on it.
 *
 * A real implementation of the seam rather than a mock, for the reason the rest
 * of them are. What matters about discovery is the judgement it comes to — that
 * a `claude` in the operator's homebrew prefix is adopted and the owned prefix
 * is not consulted, that a machine with nothing on it installs — and those are
 * decisions about a machine's contents, which is a value a test can state.
 *
 * A directory made becomes a directory that exists, because the property that
 * matters about the prefix agentplex owns is that it is there afterwards.
 */
export interface FakeSetupMachineOptions {
  readonly home?: string;
  readonly pathDirectories?: readonly string[];
  /** Directories that exist. Everything else does not, until something makes it. */
  readonly directories?: readonly string[];
  /** Full paths this user could execute. Everything else is not there. */
  readonly executables?: readonly string[];
  /** Paths a directory cannot be made at: a read-only home, a full disk. */
  readonly unmakeable?: readonly string[];
}

export interface FakeSetupMachine extends SetupMachine {
  /** Every directory a caller asked for, in order. */
  readonly made: readonly string[];
}

export function createFakeSetupMachine(options: FakeSetupMachineOptions = {}): FakeSetupMachine {
  const directories = new Set(options.directories ?? []);
  const executables = new Set(options.executables ?? []);
  const unmakeable = new Set(options.unmakeable ?? []);
  const made: string[] = [];

  return {
    home: options.home ?? '/home/dev',
    pathDirectories: options.pathDirectories ?? [],
    made,

    isDirectory: async (path) => directories.has(path),
    isExecutable: async (path) => executables.has(path),

    async makeDirectory(path: string): Promise<DirectoryMade> {
      made.push(path);
      if (unmakeable.has(path)) return { ok: false, problem: `EROFS: ${path}` };
      directories.add(path);
      return { ok: true };
    },
  };
}
