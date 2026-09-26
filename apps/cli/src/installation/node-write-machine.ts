import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { errnoCode } from '@agentplex/node-shared';
import { nodeInstallationFiles } from './node-installation-files.js';
import type { FileOutcome, WriteMachine } from './write-machine.js';

/**
 * The real disk, named in one place so that nothing in the update or install
 * path reaches for one.
 *
 * The read half is `nodeInstallationFiles`, which `status` uses, rather than a
 * second implementation of the same two questions: a settings file that reads
 * as absent to one command and unreadable to another would be two commands
 * disagreeing about the same machine.
 */
export const nodeWriteMachine: WriteMachine = {
  ...nodeInstallationFiles,

  async temporaryDirectory(): Promise<string | null> {
    try {
      return await mkdtemp(join(tmpdir(), 'agentplex-packages-'));
    } catch {
      // A machine with no writable temporary directory is a machine that cannot
      // download a runtime. It is an answer rather than a failure: the caller
      // leaves the runtime alone and says why.
      return null;
    }
  },

  async makeDirectory(path: string): Promise<FileOutcome> {
    return attempt(async () => void (await mkdir(path, { recursive: true })), path);
  },

  async removeDirectory(path: string): Promise<FileOutcome> {
    // `force` so that a directory that is not there is success: what is being
    // asked for is its absence, and both callers ask for exactly that.
    return attempt(async () => void (await rm(path, { recursive: true, force: true })), path);
  },

  async rename(from: string, to: string): Promise<FileOutcome> {
    return attempt(async () => void (await rename(from, to)), `${from} -> ${to}`);
  },

  async exists(path: string): Promise<boolean> {
    try {
      // `lstat`, so a link is something even when what it points at is not.
      await lstat(path);
      return true;
    } catch (error) {
      const code = errnoCode(error);
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
  },

  async chmod(path: string, mode: number): Promise<FileOutcome> {
    return attempt(async () => void (await chmod(path, mode)), path);
  },

  /**
   * A link made beside the one it replaces and renamed over it, which is `ln
   * -sfn` done without its gap: `symlink` refuses a path that already holds
   * one (EEXIST), and removing the old link first would leave a moment with
   * no command on the prefix's `bin`. A rename replaces a link in one step.
   */
  async link(target: string, path: string): Promise<FileOutcome> {
    const staged = `${path}.new`;
    return attempt(async () => {
      await rm(staged, { force: true });
      await symlink(target, staged);
      await rename(staged, path);
    }, `${path} -> ${target}`);
  },

  async writeFile(path: string, contents: string): Promise<FileOutcome> {
    return attempt(async () => void (await writeFile(path, contents, 'utf8')), path);
  },

  /**
   * Streamed rather than read whole. A Node tarball is around fifty megabytes,
   * and a command that held one in memory to hash it would be a command that
   * fails on the smallest machine in the fleet -- which is the machine most
   * likely to be running an old runtime.
   */
  async sha256(path: string): Promise<string | null> {
    try {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path), hash);
      return hash.digest('hex');
    } catch {
      return null;
    }
  },
};

/**
 * One change to the disk, with the reason it failed kept.
 *
 * The path is in the message because every one of these is something an
 * operator may have to go and look at: a read-only prefix, a directory owned by
 * root on a machine they are not root on, a full disk.
 */
async function attempt(act: () => Promise<void>, what: string): Promise<FileOutcome> {
  try {
    await act();
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: `${what}: ${String(error)}` };
  }
}
