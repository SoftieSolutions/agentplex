import { readdir } from 'node:fs/promises';
import { nodeWriteMachine } from '../../installation/node-write-machine.js';
import type { InstallMachine } from './install-machine.js';

/** The real disk, named in one place so nothing in this command reaches for one. */
export const nodeInstallMachine: InstallMachine = {
  ...nodeWriteMachine,

  async listDirectory(path: string): Promise<readonly string[] | null> {
    try {
      return await readdir(path);
    } catch {
      // Not there, not a directory, not readable: the script's `[ -d ]` says
      // no to each of them, and so does this.
      return null;
    }
  },
};
