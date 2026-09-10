import {
  DEFAULT_HUB_PORT,
  DEFAULT_SERVER_PORT,
  LOG_LEVELS,
  readAbsolutePath,
  readFlags,
  readPort,
  readSetting,
  settingValue,
  usageLines,
  type LogLevel,
} from '@agentplex/node-shared';
import { z } from 'zod';
import type { LocalServerEntry } from './pairing/local-server.js';

/**
 * The hub's configuration: a value produced from argv and env by a pure
 * function, so that every rule about what the hub requires is testable without
 * opening a port. `main` calls this once and wires the result.
 *
 * There is no `--role`. Which daemon runs is which program was started, and
 * this is the hub. The env var names keep their `AGENTPLEX_` prefix and their
 * meanings, so a settings file written by an installer that predates the split
 * still starts this daemon: it reads the keys it needs out of that file and a
 * key the server owns is not an error, because a setting the hub never reads is
 * a setting it never sees.
 */

export interface HubConfig {
  readonly logLevel: LogLevel;
  /** The interface to bind, a setting like any other. */
  readonly host: string;
  readonly port: number;
  /**
   * The SQLite file, absolute and normalized. The hub is the only writer to it,
   * and the directory it sits in is the operator's to create and to back up.
   */
  readonly databaseFile: string;
  /**
   * The shared credential a client presents to get a websocket ticket.
   *
   * Configuration rather than something the hub mints, because the hub has
   * nowhere to put a minted one: a server writes its token to a file the
   * operator reads, and the hub's equivalent would be a secret printed into a
   * log that `logger.ts` exists to keep secrets out of. What the operator sets
   * here is what the user types on the device, which is the whole of the
   * pairing the spec describes.
   *
   * There is no default, for the reason the database file has none, with more
   * at stake: a default would be published, and a hub is a thing on the
   * internet. A minimum length is enforced rather than trusted -- see
   * `MIN_CLIENT_TOKEN_LENGTH`.
   */
  readonly clientToken: string;
  /**
   * The server on this same machine, which the hub pairs at boot from the
   * token in its identity file, or `null` for a hub that has none.
   *
   * Configuration and not discovery, deliberately: this is the setting the
   * operator's setup run wrote, and it is the only way a pairing gets made
   * without somebody typing a token. A hub does not look for an identity file
   * on the chance that a server lives beside it; it is told. See
   * `pairing/local-server.ts` for the rest of the bounds.
   */
  readonly localServer: LocalServerEntry | null;
}

export type HubConfigResult =
  | { readonly ok: true; readonly config: HubConfig }
  /** Every problem, not the first: fixing one env var at a time is a bad loop. */
  | { readonly ok: false; readonly problems: readonly string[] };

export interface HubConfigSources {
  /** Arguments after the node binary and script path. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/** Containers reach the process from outside their own loopback. */
const DEFAULT_HOST = '0.0.0.0';

/**
 * Short enough to be typed on a phone, long enough that guessing it is not a
 * plan. 32 characters is under what `randomTokenMinter` produces (43), so the
 * documented way of generating one always passes; what this refuses is the
 * password somebody picked because it was quick, on the one credential standing
 * between the internet and every session on every paired machine.
 */
const MIN_CLIENT_TOKEN_LENGTH = 32;

/**
 * Every setting is in here, including the interface to bind. One read
 * elsewhere -- `process.env['AGENTPLEX_HOST']`, straight out of `main` -- is
 * one setting with no flag, missing from `usage()`, and rejected by `readFlags`
 * if anyone tried to type it.
 */
const SETTINGS = {
  logLevel: { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' },
  host: { flag: '--host', env: 'AGENTPLEX_HOST' },
  port: { flag: '--hub-port', env: 'AGENTPLEX_HUB_PORT' },
  databaseFile: { flag: '--database-file', env: 'AGENTPLEX_DATABASE_FILE' },
  clientToken: { flag: '--client-token', env: 'AGENTPLEX_CLIENT_TOKEN' },
  /**
   * The local server, as two settings: where its identity file is, and the
   * port it binds. The file is what makes an entry; the port takes the
   * server's default when it is not given, because that is the port the
   * server beside this hub binds when it is not told otherwise either.
   */
  localServerIdentityFile: {
    flag: '--local-server-identity-file',
    env: 'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE',
  },
  localServerPort: { flag: '--local-server-port', env: 'AGENTPLEX_LOCAL_SERVER_PORT' },
} as const;

const MISSING_DATABASE_FILE =
  'the hub needs a database: set AGENTPLEX_DATABASE_FILE or pass --database-file';

const BAD_CLIENT_TOKEN =
  'the hub needs a client token of at least ' +
  `${MIN_CLIENT_TOKEN_LENGTH} characters: set AGENTPLEX_CLIENT_TOKEN or pass --client-token ` +
  '(generate one with: openssl rand -base64 32)';

const logLevelSchema = z.enum(LOG_LEVELS);
const hostSchema = z.string().min(1);

export function loadHubConfig({ argv, env }: HubConfigSources): HubConfigResult {
  const problems: string[] = [];

  const flags = readFlags(
    argv,
    Object.values(SETTINGS).map((setting) => setting.flag),
  );
  if (!flags.ok) return { ok: false, problems: [...flags.problems] };

  const read = (setting: { readonly flag: string; readonly env: string }): string | undefined =>
    settingValue(flags.values, env, setting);

  const logLevel = readSetting(logLevelSchema, read(SETTINGS.logLevel), DEFAULT_LOG_LEVEL, (raw) =>
    problems.push(
      `unknown log level ${JSON.stringify(raw)}: expected one of ${LOG_LEVELS.join(', ')}`,
    ),
  );

  const host = readSetting(hostSchema, read(SETTINGS.host), DEFAULT_HOST, (raw) =>
    problems.push(
      `${SETTINGS.host.flag} must be an address or hostname to bind, not ${JSON.stringify(raw)}`,
    ),
  );

  const port = readPort(read(SETTINGS.port), SETTINGS.port.flag, DEFAULT_HUB_PORT, problems);

  const databaseFile = readDatabaseFile(read(SETTINGS.databaseFile), problems);
  const clientToken = readClientToken(read(SETTINGS.clientToken), problems);
  const localServer = readLocalServer(
    read(SETTINGS.localServerIdentityFile),
    read(SETTINGS.localServerPort),
    problems,
  );

  if (problems.length > 0 || databaseFile === undefined || clientToken === undefined) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    config: { logLevel, host, port, databaseFile, clientToken, localServer },
  };
}

/**
 * The hub's database, or the reason there isn't one.
 *
 * There is no default. A path invented here would be a file somebody has to
 * find later in order to back it up, and inventing one under the working
 * directory is how a hub ends up with two databases and no error.
 */
function readDatabaseFile(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined) {
    problems.push(MISSING_DATABASE_FILE);
    return undefined;
  }
  return readAbsolutePath(raw, SETTINGS.databaseFile.flag, problems);
}

/**
 * The client credential. Absent and too short are one problem with one
 * message, because they are one mistake: somebody has not yet put a real
 * secret here. It is trimmed by `settingValue` before it arrives, so a token
 * cannot pick up the whitespace an env file left around it and then fail to
 * match what the user typed.
 */
function readClientToken(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined || raw.length < MIN_CLIENT_TOKEN_LENGTH) {
    problems.push(BAD_CLIENT_TOKEN);
    return undefined;
  }
  return raw;
}

/**
 * The local server the hub pairs at boot, or `null` when the settings name
 * none.
 *
 * The identity file is what makes an entry. A port on its own names nothing --
 * there is no file to read a token from -- and is refused rather than ignored,
 * because a setting that is read and does nothing is the shape of a typo that
 * costs somebody an afternoon. The path is absolute for the reason the server's
 * own identity path is: a relative one names a different file per working
 * directory, and a hub that read a different token than the server holds would
 * dial its own machine and be refused, with nothing pointing at the cause.
 */
function readLocalServer(
  rawPath: string | undefined,
  rawPort: string | undefined,
  problems: string[],
): LocalServerEntry | null {
  if (rawPath === undefined) {
    if (rawPort !== undefined) {
      problems.push(
        `${SETTINGS.localServerPort.flag} names a port for a local server, but no ` +
          `${SETTINGS.localServerIdentityFile.flag} names its identity file`,
      );
    }
    return null;
  }
  const identityPath = readAbsolutePath(rawPath, SETTINGS.localServerIdentityFile.flag, problems);
  const port = readPort(rawPort, SETTINGS.localServerPort.flag, DEFAULT_SERVER_PORT, problems);
  return identityPath === undefined ? null : { identityPath, port };
}

/** The flags this program understands, for a usage message. */
export function hubUsage(): string {
  return ['Usage: agentplex hub [options]', '', ...usageLines(Object.values(SETTINGS))].join('\n');
}
