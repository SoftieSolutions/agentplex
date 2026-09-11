import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { nodeInstallationFiles } from '../../installation/node-installation-files.js';
import type { FileOutcome, UpdateMachine } from './update-machine.js';

/**
 * The real disk, and the real terminal, named in one place so that nothing in
 * the update path reaches for either.
 *
 * The read half is `nodeInstallationFiles`, which `status` uses, rather than a
 * second implementation of the same two questions: a settings file that reads
 * as absent to one command and unreadable to another would be two commands
 * disagreeing about the same machine.
 */
export const nodeUpdateMachine: UpdateMachine = {
  ...nodeInstallationFiles,

  async temporaryDirectory(): Promise<string | null> {
    try {
      return await mkdtemp(join(tmpdir(), 'agentplex-update-'));
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

  /**
   * One question, asked of whoever is at this machine.
   *
   * `/dev/tty` is *opened* rather than tested, which is `have_terminal()`'s
   * rule and is captured rather than reasoned about: `[ -r /dev/tty ]` answers
   * yes in a container with no controlling terminal, and the open then fails
   * with ENXIO. The consequence of getting it wrong is worse here than in the
   * installer -- a prompt nobody can answer is an update that hangs with the
   * daemons already stopped.
   *
   * The question is then put on `/dev/tty` itself rather than on stdin, and
   * that is the other half of the same decision. An update can be run with its
   * stdin redirected -- from a script, from `/dev/null`, out of a pipeline --
   * and the operator's terminal is still there; asking on the terminal reaches
   * the person, where asking on stdin would read a line of somebody's script as
   * an answer about replacing a runtime.
   */
  async askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'> {
    let terminal;
    try {
      terminal = await open('/dev/tty', 'r+');
    } catch {
      return 'nobody';
    }

    try {
      const input = terminal.createReadStream();
      const output = terminal.createWriteStream();
      const lines = createInterface({ input, output });
      try {
        const answer = await new Promise<string | null>((resolve) => {
          // Both, in order, from one emitter: an input that ends while a
          // question is outstanding never settles if only the answer is waited
          // for, and racing two emitters throws away a line that arrived in the
          // same tick. The wizard's terminal carries the same note at length.
          lines.once('line', (text: string) => resolve(text));
          lines.once('close', () => resolve(null));
          lines.setPrompt(`${question} [y/N] `);
          lines.prompt();
        });
        if (answer === null) return 'nobody';
        return ['y', 'yes'].includes(answer.trim().toLowerCase()) ? 'yes' : 'no';
      } finally {
        lines.close();
      }
    } finally {
      await terminal.close();
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
