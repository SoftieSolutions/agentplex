import { join } from 'node:path';
import { firstLine } from '@agentplex/node-shared';
import {
  runOperation,
  type Operation,
  type ProcessRunner,
  type OperationOutcome,
} from '@agentplex/providers';
import { z } from 'zod';
import { PACKAGE_DIRECTORY, binDirectory, stateDirectory, type Layout } from './layout.js';
import type { FileOutcome, WriteMachine } from './write-machine.js';

/**
 * What the service account owns on a `--system` machine: its state and the
 * trees npm writes into, and not the interpreter it is started through.
 * This was `install.sh`'s step, and its argument came here with it when the
 * script handed the install over; the script only creates the account.
 *
 * Something under the prefix has to be writable by that account. `agentplex
 * setup` installs providers with `npm install --global --prefix $PREFIX` as the
 * service account, so a wholly root-owned prefix would turn the first provider
 * install into a permission error nobody would connect to the installer. The
 * question this answers is how much.
 *
 * `chown -R $PREFIX` was the old answer, and the blast radius was the whole
 * prefix. This account runs coding agents, which is the most exposed program on
 * the machine; owning the prefix meant owning `$PREFIX/node/bin/node` -- the
 * interpreter ExecStart resolves through -- so anything that got out of a
 * session could replace the runtime and be re-executed on every restart
 * thereafter, and could rewrite the settings file holding the client token.
 *
 * So: the two directories npm installs a global package into, `$PREFIX/share`
 * beside them, and the state directory. `$PREFIX` itself, `$PREFIX/lib` and
 * `$PREFIX/node` stay root's.
 *
 * `$PREFIX/share` is the one that is not obvious. npm links a package's man
 * pages into `<prefix>/share/man` and creates the directory on the way, so an
 * account that cannot write the prefix root ends a provider install with EACCES
 * on mkdir. Run rather than reasoned about: npm 11 installing a package with a
 * `man` field into a prefix whose root it did not own failed exactly there, and
 * succeeded once `share/` existed and was its own.
 *
 * What this does not buy, and must not be read as claiming: the account still
 * owns `$PREFIX/lib/node_modules` and `$PREFIX/bin`, so it can still overwrite
 * agentplex's own code and the link that is started. It cannot replace the
 * interpreter and it cannot rewrite its own settings. That is a reduction in
 * what one compromised session reaches, not isolation from it; isolating the
 * package tree as well means a second prefix for providers, which is not this.
 *
 * ## Why the path is an enum
 *
 * A recursive `chown` handed the wrong path is the whole prefix given away --
 * the exact thing the paragraphs above exist to prevent. So the request's path
 * is not "a path": it is one of the four this layout computes, parsed as such,
 * and anything else is refused before an argv is built. The account is parsed
 * as a user name for the same reason, so that neither element of the argv can
 * be something a user name is not.
 */

/** Longer than a local chown of a few thousand files takes, and not a budget. */
const CHOWN_TIMEOUT_MS = 120_000;

/** A question the account database answers without the disk. */
const ID_TIMEOUT_MS = 10_000;

/**
 * A user name as `useradd` takes one: lowercase, a letter or underscore first,
 * then letters, digits, `_` and `-`, at most 32. Nothing that could be read as
 * a flag, a separator or a second word.
 */
const accountSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'a user name: lowercase letters, digits, _ and -');

/**
 * The four paths the account owns under this layout, in the order the
 * installer gives them: `$BIN_DIR`, `$PREFIX/lib/node_modules`,
 * `$PREFIX/share`, `$STATE_DIR`.
 */
export function ownedPaths(layout: Layout): readonly [string, string, string, string] {
  return [
    binDirectory(layout),
    join(layout.prefix, PACKAGE_DIRECTORY),
    join(layout.prefix, 'share'),
    stateDirectory(layout),
  ];
}

function grantRequestSchema(layout: Layout) {
  return z.strictObject({ account: accountSchema, path: z.enum(ownedPaths(layout)) });
}

export type GrantRequest = z.infer<ReturnType<typeof grantRequestSchema>>;

/**
 * `chown -R <account>:<account> <path>`, for one of the four paths this layout
 * computes and no other.
 *
 * Built per layout because the enum is: the paths are the layout's, and a
 * schema that allowed "any of the four under any prefix" would allow any path
 * at all.
 */
export function grantOwnershipOperation(layout: Layout): Operation<GrantRequest, null> {
  return {
    name: 'account.own-tree',
    summary: 'give the service account one of the directories it writes into',
    request: grantRequestSchema(layout),
    timeoutMs: CHOWN_TIMEOUT_MS,
    argv: (request) => ({
      file: 'chown',
      args: ['-R', `${request.account}:${request.account}`, request.path],
    }),
    read: chownResult,
  };
}

function settingsRequestSchema(layout: Layout) {
  return z.strictObject({ account: accountSchema, path: z.literal(layout.settingsFile) });
}

export type SettingsOwnerRequest = z.infer<ReturnType<typeof settingsRequestSchema>>;

/**
 * `chown root:<account> <settings file>`: root's file, which the account may
 * read through its group and not rewrite. Not recursive, and the one path it
 * takes is the layout's settings file.
 *
 * A daemon that can rewrite its own settings is a session that can point this
 * machine's server at another hub on the next restart, and the file is written
 * once by an installer anyway: nothing after this has any business writing it
 * as the account. The owner and the mode are one decision and are set
 * together, by the caller, in the installer's order: this, then `0640`.
 */
export function settingsOwnershipOperation(layout: Layout): Operation<SettingsOwnerRequest, null> {
  return {
    name: 'account.settings-group',
    summary: 'give the settings file to root, readable by the service account',
    request: settingsRequestSchema(layout),
    timeoutMs: CHOWN_TIMEOUT_MS,
    argv: (request) => ({ file: 'chown', args: [`root:${request.account}`, request.path] }),
    read: chownResult,
  };
}

function chownResult(completed: {
  readonly exitCode: number;
  readonly stderr: string;
}): OperationOutcome<null> {
  return completed.exitCode === 0
    ? { ok: true, result: null }
    : {
        ok: false,
        refusal: 'failed',
        problem: firstLine(completed.stderr) || `chown exited ${String(completed.exitCode)}`,
      };
}

const accountRequestSchema = z.strictObject({ account: accountSchema });

/**
 * Whether the service account exists: `id -u <account>`, the question
 * `ensure_service_account` asks. Exit 0 is yes and exit 1 -- `id`'s "no such
 * user" -- is no; anything else is a question that went unanswered.
 *
 * Creating the account is the bootstrap's, with `useradd`, and stays there: a
 * program that adds users to a machine is the installer, and this command is
 * run by it.
 */
export const serviceAccountOperation: Operation<z.infer<typeof accountRequestSchema>, boolean> = {
  name: 'account.exists',
  summary: 'ask whether the service account exists',
  request: accountRequestSchema,
  timeoutMs: ID_TIMEOUT_MS,
  argv: (request) => ({ file: 'id', args: ['-u', request.account] }),
  read: (completed) => {
    if (completed.exitCode === 0) return { ok: true, result: true };
    if (completed.exitCode === 1) return { ok: true, result: false };
    return {
      ok: false,
      refusal: 'failed',
      problem: firstLine(completed.stderr) || `id exited ${String(completed.exitCode)}`,
    };
  },
};

export interface OwnershipDependencies {
  readonly machine: Pick<WriteMachine, 'makeDirectory'>;
  readonly runner: ProcessRunner;
}

/**
 * Each of the four made, then given to the account, in order.
 *
 * Made rather than assumed to be there: the install makes `bin/` and
 * `lib/node_modules`, but nothing makes `share/` until npm installs a provider
 * with man pages, and the state directory exists only if whoever made the
 * account made it. Recursive, so it reaches every tree the swap just moved
 * into place, all of which root unpacked and npm filled.
 */
export async function grantServiceAccountOwnership(
  layout: Layout,
  account: string,
  { machine, runner }: OwnershipDependencies,
): Promise<FileOutcome> {
  const operation = grantOwnershipOperation(layout);
  for (const path of ownedPaths(layout)) {
    const made = await machine.makeDirectory(path);
    if (!made.ok) return made;
    const owned = await runOperation(operation, { account, path }, runner);
    if (!owned.ok) {
      return { ok: false, problem: `${account} could not be given ${path}: ${owned.problem}` };
    }
  }
  return { ok: true };
}
