import { createFakeInstallationFiles } from '../../installation/fake-installation-files.js';
import type { FakeInstallationFilesOptions } from '../../installation/fake-installation-files.js';
import type { InstallMachine } from './install-machine.js';

/**
 * A machine a test writes down, and every question it was asked.
 *
 * The questions are recorded because one claim about this command is about
 * what it did not do: `--print-unit` asks about the interpreter and nothing
 * else, and a dry run with no local manifest reads none.
 */
export interface FakeInstallMachineOptions extends FakeInstallationFilesOptions {
  /** Directories that list, by their entries. Anything else is not a directory. */
  readonly directories?: Readonly<Record<string, readonly string[]>>;
}

export interface FakeInstallMachine extends InstallMachine {
  /** `isFile <path>`, `readFile <path>` and `listDirectory <path>`, in order. */
  readonly asked: readonly string[];
}

export function createFakeInstallMachine(
  options: FakeInstallMachineOptions = {},
): FakeInstallMachine {
  const files = createFakeInstallationFiles(options);
  const directories = new Map(Object.entries(options.directories ?? {}));
  const asked: string[] = [];

  return {
    asked,

    async readFile(path: string) {
      asked.push(`readFile ${path}`);
      return files.readFile(path);
    },

    async isFile(path: string) {
      asked.push(`isFile ${path}`);
      return files.isFile(path);
    },

    async listDirectory(path: string) {
      asked.push(`listDirectory ${path}`);
      return directories.get(path) ?? null;
    },
  };
}
