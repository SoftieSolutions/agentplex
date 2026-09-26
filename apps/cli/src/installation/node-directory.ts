import { dirname, join } from 'node:path';
import {
  runOperation,
  type Operation,
  type ProcessRunner,
  type ProgramResolver,
} from '@agentplex/providers';
import { z } from 'zod';
import type { InstallationFiles } from './installation-files.js';
import { nodeBinary, type Layout } from './layout.js';

/**
 * Which directory's `node` a unit's ExecStart names.
 *
 * `resolve_node_directory` in `install.sh`, restated: the prefix's own runtime
 * when it is there and of a recent major; otherwise the `node` a PATH lookup
 * finds, when that one is recent; otherwise the prefix's runtime directory,
 * which is where the installer unpacks one. The unit names whatever this
 * decides, so the two programs have to decide it the same way.
 *
 * Never `process.execPath`. That is the interpreter this command happens to run
 * under, and it is the resolved real path: a Homebrew or version-manager node
 * would be written into the unit as a versioned directory that the next upgrade
 * of that node deletes. A PATH lookup answers with the directory as PATH names
 * it -- the shim, the stable link -- which is what `command -v node` answers in
 * the script.
 */

/** The Node major this project declares in `engines`, and what counts as recent. */
export const NODE_MAJOR = '24';

/** `node --version` prints and exits; anything slower is a node that is not answering. */
const VERSION_TIMEOUT_MS = 10_000;

const versionRequestSchema = z.strictObject({
  /** The interpreter, by its full path: the prefix's, or the one PATH resolved. */
  node: z.string().min(1),
});

/**
 * `node_major_is_recent`'s `"$1" --version`, as the one operation that asks it.
 *
 * The file is a path rather than a program name, as `npm-install.ts` hands npm
 * its own: the prefix's runtime is on no search path, so naming it is the only
 * way to ask it anything. The answer is the major, read the way the script
 * reads it -- a leading `v` dropped, everything from the first `.` dropped, and
 * what is left refused unless it is all digits.
 */
export const nodeVersionOperation: Operation<z.infer<typeof versionRequestSchema>, number> = {
  name: 'node.version',
  summary: 'ask an interpreter which Node major it is',
  request: versionRequestSchema,
  timeoutMs: VERSION_TIMEOUT_MS,
  argv: (request) => ({ file: request.node, args: ['--version'] }),
  read: (completed, request) => {
    const major = completed.stdout.trim().replace(/^v/, '').split('.')[0] ?? '';
    return completed.exitCode === 0 && /^[0-9]+$/.test(major)
      ? { ok: true, result: Number(major) }
      : { ok: false, refusal: 'failed', problem: `${request.node} did not say its version` };
  },
};

export interface NodeDirectoryDependencies {
  readonly files: InstallationFiles;
  readonly programs: ProgramResolver;
  readonly runner: ProcessRunner;
}

export async function resolveNodeDirectory(
  layout: Layout,
  { files, programs, runner }: NodeDirectoryDependencies,
): Promise<string> {
  const owned = nodeBinary(layout);
  if ((await files.isFile(owned)) && (await isRecent(owned, runner))) return dirname(owned);

  const found = await programs.resolve('node');
  if (found !== null && (await isRecent(join(found, 'node'), runner))) return found;

  return dirname(owned);
}

/** Whether an interpreter answers with a major at least `NODE_MAJOR`. */
async function isRecent(node: string, runner: ProcessRunner): Promise<boolean> {
  const outcome = await runOperation(nodeVersionOperation, { node }, runner);
  return outcome.ok && outcome.result >= Number(NODE_MAJOR);
}
