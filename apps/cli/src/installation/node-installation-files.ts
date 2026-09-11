import { readFile, stat } from 'node:fs/promises';
import type { FileRead } from '@agentplex/providers';
import type { InstallationFiles } from './installation-files.js';

/**
 * The real disk, named in one place so that nothing in the three installation
 * commands reaches for one.
 *
 * A read that fails for a reason other than absence keeps its reason. That
 * matters more here than anywhere else in this app: the settings file a
 * `--system` install writes is `root:agentplex` at 0640, so an operator who is
 * neither gets `EACCES`, and "there is no agentplex installed here" would be
 * exactly the wrong sentence to tell them.
 */
export const nodeInstallationFiles: InstallationFiles = {
  async readFile(path: string): Promise<FileRead> {
    try {
      return { kind: 'read', contents: await readFile(path, 'utf8') };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
      return { kind: 'failed', reason: String(error) };
    }
  },

  async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
