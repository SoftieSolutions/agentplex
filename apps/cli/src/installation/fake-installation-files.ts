import type { FileRead } from '@agentplex/providers';
import type { InstallationFiles } from './installation-files.js';

/**
 * A machine a test writes down: a map of paths to contents, and a set of paths
 * that are files with nothing worth reading in them.
 *
 * A real implementation of the seam rather than a mock, for the reason every
 * other fake here is one. What matters about these commands is what they make
 * of a prefix that is half there -- a settings file with no packages beside it,
 * a unit file for one daemon and not the other, a manifest that is not JSON --
 * and every one of those is a literal in this table rather than a directory
 * somebody has to build.
 */
export interface FakeInstallationFilesOptions {
  /** Paths that read, by contents. Every one of them is also a file. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths that are files but are never read: a unit, an interpreter. */
  readonly present?: readonly string[];
  /** Paths that exist and refuse to be read, by the reason they refuse. */
  readonly unreadable?: Readonly<Record<string, string>>;
}

export function createFakeInstallationFiles(
  options: FakeInstallationFilesOptions = {},
): InstallationFiles {
  const files = new Map(Object.entries(options.files ?? {}));
  const unreadable = new Map(Object.entries(options.unreadable ?? {}));
  const present = new Set([...(options.present ?? []), ...files.keys(), ...unreadable.keys()]);

  return {
    async readFile(path: string): Promise<FileRead> {
      const reason = unreadable.get(path);
      if (reason !== undefined) return { kind: 'failed', reason };
      const contents = files.get(path);
      return contents === undefined ? { kind: 'missing' } : { kind: 'read', contents };
    },

    async isFile(path: string): Promise<boolean> {
      return present.has(path);
    },
  };
}
