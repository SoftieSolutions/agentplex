import { join } from 'node:path';
import { SERVER_SETTINGS } from '@agentplex/node-shared';
import type { SetupOutcome } from './apply-setup-plan.js';
import { SETTINGS_FILE_NAME } from '../../installation/layout.js';
import { writeSettings, type Setting } from './settings-file.js';
import type { SetupMachine } from './setup-machine.js';

/**
 * Recording the server's own identity file: the path it presents its token from.
 *
 * The apply path mints the identity at the plan's path, `<prefix>/server.json`,
 * and a server that is not told that reads `$HOME/.agentplex/server.json`
 * instead. Those are one file only when the prefix is the one setup owns by
 * itself. Under any other -- an installer's `--prefix`, or one typed by hand --
 * the server minted a second identity with a different token at its first
 * start, and nothing said so: the token setup reported paired nothing, and on
 * `--role=both` the hub was refused by its own server. So the path is written
 * wherever setup has a server identity at all, whatever the prefix, and the
 * default is never what makes the two agree.
 *
 * Into `<prefix>/agentplex.env`, the file the per-user units read, and not
 * asked for. Both front ends take this step, the wizard and a replayed plan,
 * because it is not a pairing: which hub a machine belongs to is the operator's
 * to say, and a replay says nothing about it, but this is the server being told
 * where its own file is, which the plan being applied already named.
 * `alreadyIn` is a file the wizard's pairing step wrote, which carries the same
 * line, so that file is not written a second time.
 *
 * An identity the apply path could not settle is not recorded: the apply path
 * has already reported it, and a line pointing at a file that is not an
 * identity would be recording a problem as a setting. That is `null`.
 *
 * A failure costs itself, for the reason the pairing's does: the machine is
 * provisioned, and the flag to start the server with is the whole of the fix.
 * Each front end decides where that sentence goes.
 */
export async function recordServerIdentity(
  outcome: SetupOutcome,
  prefix: string,
  alreadyIn: string | null,
  machine: SetupMachine,
): Promise<ServerIdentityRecord | null> {
  const server = outcome.server;
  if (server === null || server.identity.problem !== null) return null;

  const identityPath = server.identity.path;
  const path = join(prefix, SETTINGS_FILE_NAME);
  const written =
    path === alreadyIn
      ? { ok: true as const }
      : await writeSettings(path, [serverIdentitySetting(identityPath)], machine);
  const flag = `${SERVER_SETTINGS.serverIdentityFile.flag} ${identityPath}`;

  return written.ok
    ? {
        recorded: true,
        line:
          `Recorded ${identityPath} as this server's identity file in ${path}. Start the ` +
          `server from that file (the unit reads it as its EnvironmentFile), or pass ${flag}.`,
      }
    : {
        recorded: false,
        line:
          `This server's identity file was not recorded: ${written.problem}. Start the server ` +
          `with ${flag}, or it keeps an identity of its own under its home, with another token.`,
      };
}

/** What recording the identity file came to, in the sentence that says so. */
export interface ServerIdentityRecord {
  readonly recorded: boolean;
  readonly line: string;
}

/** The setting that names the server's identity file, as the server's config reads it. */
export function serverIdentitySetting(identityPath: string): Setting {
  return { key: SERVER_SETTINGS.serverIdentityFile.env, value: identityPath };
}
