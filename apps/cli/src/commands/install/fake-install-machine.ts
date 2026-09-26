import {
  createFakeWriteMachine,
  type FakeWriteMachine,
  type FakeWriteMachineOptions,
} from '../../installation/fake-write-machine.js';
import type { InstallMachine } from './install-machine.js';

/**
 * A machine a test writes down, every question it was asked, and everything
 * the install did to it.
 *
 * The disk is the write-machine fake `update` shares, so an install is read
 * back the way an update is: the acts in order and the contents left behind.
 * The questions are recorded as well, because one claim about this command is
 * about what it did not do: `--print-unit` asks about the interpreter and
 * nothing else, and a dry run with no local manifest reads none.
 */
export interface FakeInstallMachineOptions extends FakeWriteMachineOptions {
  /** Directories that list, by their entries. Anything else is not a directory. */
  readonly directories?: Readonly<Record<string, readonly string[]>>;
}

export interface FakeInstallMachine extends FakeWriteMachine, InstallMachine {
  /** `isFile <path>`, `readFile <path>`, `exists <path>` and `listDirectory <path>`, in order. */
  readonly asked: readonly string[];
}

export function createFakeInstallMachine(
  options: FakeInstallMachineOptions = {},
): FakeInstallMachine {
  const disk = createFakeWriteMachine(options);
  const directories = new Map(Object.entries(options.directories ?? {}));
  const asked: string[] = [];

  return {
    ...disk,
    asked,

    async readFile(path: string) {
      asked.push(`readFile ${path}`);
      return disk.readFile(path);
    },

    async isFile(path: string) {
      asked.push(`isFile ${path}`);
      return disk.isFile(path);
    },

    async exists(path: string) {
      asked.push(`exists ${path}`);
      return disk.exists(path);
    },

    async listDirectory(path: string) {
      asked.push(`listDirectory ${path}`);
      return directories.get(path) ?? null;
    },
  };
}
