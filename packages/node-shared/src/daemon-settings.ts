import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { LOG_LEVELS, type LogLevel } from './logger.js';
import {
  DEFAULT_SERVER_PORT,
  nonEmpty,
  readAbsolutePath,
  readPort,
  readSetting,
  type Setting,
} from './settings.js';
import { MIN_TOKEN_LENGTH } from './tokens.js';

/**
 * The daemons' settings: which ones there are, and what each one may say.
 *
 * Three programs read one settings file. The server and the hub each read the
 * keys they need out of it, and `agentplex doctor` reads both halves to report
 * on the deployment they describe. While each held its own table and its own
 * parsers, the doctor was a third copy of rules that lived in two apps it may
 * not import, and a copy is a rule that drifts: a flag the server accepted and
 * the doctor refused, a default the doctor restated and the server changed.
 * So the tables and the parsers are here, and each program keeps only what is
 * genuinely its own -- whether an absent setting is a refusal or a finding.
 *
 * That line is where sharing stops. A parser here is shared whole only where
 * every caller means the same thing by "absent": a timezone nobody set is an
 * inherited one to all three. The hub refuses to start without a database file
 * or a client token, while the doctor reports the same absence as a line in
 * its report, so those two keep their own readers and share only the rule for
 * a value that is present.
 *
 * What comes back is structural, never a type another package owns. This
 * package sits under `providers` and beside both daemons, so a pairing token is
 * `{ token, setting }` and a local server is `{ identityPath, port }`, and the
 * types each app names them by accept these as they stand.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Containers reach the process from outside their own loopback. */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * Terminals a machine can hold at once, absent configuration.
 *
 * Each one is a forked agent plus its scrollback, and the number is a guess at
 * a laptop rather than at a server. It is deliberately larger than the number
 * of sessions a person watches at once and small enough that the eviction rule
 * gets exercised rather than being theatre nobody ever reaches.
 */
export const DEFAULT_TERMINAL_CAP = 8;

/**
 * How long a drain waits, absent configuration, in milliseconds.
 *
 * Chosen against the unit, not against a feeling. `install.sh` writes
 * `TimeoutStopSec=20s` and renders this number from the same pair, so a machine
 * has one number and a five-second margin: what is left when the drain gives up
 * is what this process has to kill the stragglers, close its sockets and exit
 * before systemd stops caring. This default is what a checkout, a container and
 * anything else without that unit gets, and it matches what the installer
 * writes so that the two cannot say different things about the same server.
 */
export const DEFAULT_DRAIN_MS = 15_000;

/**
 * What the server's own paths fall back to under the account's home.
 *
 * The same directory an install already owns: a plain `install.sh` run puts
 * the prefix at `$HOME/.agentplex` and makes that the state directory too, so
 * on the tier most machines are, the default is where everything else about
 * agentplex on that machine already is -- and it is where `agentplex setup`
 * mints the identity file.
 *
 * On the `--system` tier the account's home is `/var/lib/agentplex` -- the
 * state directory the installer created for it, not `/opt/agentplex`, which is
 * root-owned runtime the account may not write to. Defaulting off the home
 * rather than off `AGENTPLEX_PREFIX` is what keeps those two apart: the prefix
 * is where the programs live and the home is where the account's own files go,
 * and AGX-158 separated them on purpose. That tier does not lean on the
 * identity default at all: its installer records the identity file outright.
 */
const HOME_DIRECTORY = '.agentplex';
const IDENTITY_FILE_NAME = 'server.json';

/**
 * The data root's setting, named here and exported because the module that
 * owns the directory has to name it too: every refusal `ensureDataRoot`
 * produces tells the operator which setting to change, and a second spelling
 * of it there would be a message pointing at a variable that does not exist.
 */
export const DATA_PATH = { flag: '--data-path', env: 'AGENTPLEX_DATA_PATH' } as const;

/** The two every daemon reads. */
const LOG_LEVEL = { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' } as const;
const HOST = { flag: '--host', env: 'AGENTPLEX_HOST' } as const;

/**
 * Each setting has one flag and one env var. Flags win, because a flag is
 * typed by a person at the moment they mean it and an env var is inherited.
 *
 * Every setting is in here, including the interface to bind. One read
 * elsewhere -- `process.env['AGENTPLEX_HOST']`, straight out of `main` -- is one
 * setting with no flag, missing from `usage()`, and rejected by `readFlags` if
 * anyone tried to type it.
 */
export const SERVER_SETTINGS = {
  logLevel: LOG_LEVEL,
  host: HOST,
  serverPort: { flag: '--server-port', env: 'AGENTPLEX_SERVER_PORT' },
  /** Repeatable: a server may mount more than one store. */
  storePath: { flag: '--store-path', env: 'AGENTPLEX_STORE_PATH' },
  /** Repeatable, and ordered: the first directory holding a program wins. */
  binPath: { flag: '--bin-path', env: 'AGENTPLEX_BIN_PATH' },
  /**
   * Repeatable: a machine may offer more than one place to browse.
   *
   * The flag is singular and the variable is plural because each names what it
   * holds: one `--browse-root` is one root and the operator repeats it, and the
   * variable is one string holding the whole list, separated the way every
   * other path list here is. `--store-path` predates this and spells it the
   * other way round; matching it would have made the flag read as though a
   * machine had one.
   */
  browseRoot: { flag: '--browse-root', env: 'AGENTPLEX_BROWSE_ROOTS' },
  serverIdentityFile: {
    flag: '--server-identity-file',
    env: 'AGENTPLEX_SERVER_IDENTITY_FILE',
  },
  /**
   * A flag, like every other setting, and that was the decision rather than
   * the default.
   *
   * A secret on an argv is a secret in `ps` output, which is the one cost the
   * other settings here do not carry, and taking the exception was the
   * alternative. It was not taken because the repository has already decided
   * this, in the other direction, for a strictly larger secret: the hub's
   * `--client-token` is the one credential between the internet and every
   * session on every paired machine, and it has a flag. An exception carved
   * out for the smaller secret and not the larger one is not a position on
   * process listings, it is an inconsistency that teaches nothing. If argv is
   * the wrong channel for a credential it is wrong for both, and that is one
   * decision taken once rather than here.
   *
   * The deployment this setting exists for pays nothing either way: an
   * orchestrator injects an environment variable, and the flag is the path
   * nobody on that tier uses.
   */
  serverToken: { flag: '--server-token', env: 'AGENTPLEX_SERVER_TOKEN' },
  dataPath: DATA_PATH,
  /**
   * Named for the variable it becomes rather than for the word this codebase
   * uses in prose. `TZ` is what a child reads, `AGENTPLEX_TZ` is the setting
   * that decides it, and an operator reading a unit file beside a session's
   * environment should not have to be told they are the same thing.
   */
  timezone: { flag: '--tz', env: 'AGENTPLEX_TZ' },
  terminalCap: { flag: '--terminal-cap', env: 'AGENTPLEX_TERMINAL_CAP' },
  /**
   * In seconds, because the number it has to agree with is in the unit beside
   * it and systemd writes `TimeoutStopSec=20s`. Two settings in two units for
   * one decision is how the two drift.
   */
  drainSeconds: { flag: '--drain-seconds', env: 'AGENTPLEX_SERVER_DRAIN_SECONDS' },
  /**
   * Takes `true` or `false` rather than being a bare presence flag, which
   * `readFlags` would refuse anyway: every setting here has one value, and a
   * flag with none is a typo. It earns its keep beyond consistency, too -- an
   * image that sets `AGENTPLEX_ANNOUNCE=true` can be run quiet with
   * `--announce=false`, which a presence flag could never express.
   */
  announce: { flag: '--announce', env: 'AGENTPLEX_ANNOUNCE' },
} as const satisfies Record<string, Setting>;

/** The hub's table, built the same way and for the same reasons. */
export const HUB_SETTINGS = {
  logLevel: LOG_LEVEL,
  host: HOST,
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
} as const satisfies Record<string, Setting>;

const logLevelSchema = z.enum(LOG_LEVELS);
const hostSchema = z.string().min(1);

export function readLogLevel(raw: string | undefined, problems: string[]): LogLevel {
  return readSetting(logLevelSchema, raw, DEFAULT_LOG_LEVEL, (offending) =>
    problems.push(
      `unknown log level ${JSON.stringify(offending)}: expected one of ${LOG_LEVELS.join(', ')}`,
    ),
  );
}

export function readHost(raw: string | undefined, problems: string[]): string {
  return readSetting(hostSchema, raw, DEFAULT_HOST, (offending) =>
    problems.push(
      `${HOST.flag} must be an address or hostname to bind, not ${JSON.stringify(offending)}`,
    ),
  );
}

/**
 * The zone, checked against the database a child will look it up in, and kept
 * as the operator spelled it.
 *
 * Checked rather than passed through, because the failure a typo causes is
 * silent: a child handed a `TZ` that names no zone does not refuse, it sits in
 * UTC, and the operator finds out weeks later when an agent tells them the
 * wrong day. A check here turns that into one sentence at startup, next to
 * every other thing wrong with the settings file.
 *
 * What it is checked against was measured rather than assumed, and it is not
 * the obvious list. `Intl.supportedValuesOf('timeZone')` is ICU's *canonical*
 * names: on Node 24 it holds 418 of them and none of them is `UTC`, no `US/*`
 * name is in it, and it offers `Asia/Calcutta` and `Europe/Kiev` where tzdata
 * has long since preferred `Asia/Kolkata` and `Europe/Kyiv`. A membership test
 * against that list would refuse `AGENTPLEX_TZ=UTC`, which is worse than not
 * checking at all: it would reject names the operator's own `date` accepts.
 *
 * Asking ICU to format with the zone asks the same database the question that
 * matters, and it answers the way a machine does -- `UTC`, `US/Pacific`,
 * `Asia/Kolkata` and `Europe/Kyiv` are accepted, `Europe/Madird` and
 * `Mars/Phobos` throw.
 *
 * The name is kept as typed, with one exception. Every alias ICU accepts is a
 * real entry in the tz database, so a child finds it: `date` reports PDT for
 * `US/Pacific` and IST for `Asia/Kolkata` inside `node:24-bookworm-slim`.
 * Replacing them with what ICU canonicalizes them to would put `Asia/Calcutta`
 * in a session whose operator wrote `Asia/Kolkata`. The exception is
 * capitalization: ICU matches a zone name case-insensitively and the tz
 * database is a directory of files, so `america/new_york` is a name ICU knows
 * and glibc does not -- a child given it falls back to UTC silently, and
 * `date` prints `america +0000`. That one is normalized to the spelling ICU
 * just named, for the reason a path is normalized rather than refused: it is
 * the same zone, said differently.
 */
export function readTimezone(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined) return undefined;

  const named = zoneNamed(raw);
  if (named === undefined) {
    problems.push(
      `${SERVER_SETTINGS.timezone.flag} must be a timezone this machine knows, like Europe/Madrid ` +
        `or UTC, not ${JSON.stringify(raw)}`,
    );
    return undefined;
  }

  return named.toLowerCase() === raw.toLowerCase() ? named : raw;
}

/** What ICU says that name is, or nothing when it says no. */
function zoneNamed(raw: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The terminal cap: a whole number of terminals, at least one.
 *
 * Zero is refused rather than taken literally. It would parse, and it would
 * mean a server that accepts sessions and can never run one -- a configuration
 * whose only symptom is every launch being refused for a reason that reads like
 * a bug. There is no upper bound: how much memory the machine has is the
 * operator's to know, and a ceiling invented here would be wrong on the box
 * that was bought to run twenty of them.
 */
export function readTerminalCap(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_TERMINAL_CAP;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 1) {
    problems.push(
      `${SERVER_SETTINGS.terminalCap.flag} must be a whole number of terminals, at least 1, not ${JSON.stringify(raw)}`,
    );
    return DEFAULT_TERMINAL_CAP;
  }
  return cap;
}

/**
 * The drain budget: a whole number of seconds, none of them negative.
 *
 * Seconds in, milliseconds out, because the operator reads this line next to
 * `TimeoutStopSec=20s` and everything below counts in milliseconds. Zero is
 * accepted rather than refused the way a zero terminal cap is: a cap of zero
 * describes a server that can never do its job, and a drain of zero describes
 * one that shuts down the way it did before this existed. There is no upper
 * bound here, because the bound that matters is the unit's and this file cannot
 * see it -- a drain longer than `TimeoutStopSec` is not a longer drain, it is
 * the same SIGKILL with a wait in front of it, and the installer is what keeps
 * the two in step.
 */
export function readDrainSeconds(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_DRAIN_MS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) {
    problems.push(
      `${SERVER_SETTINGS.drainSeconds.flag} must be a whole number of seconds, none of them negative, not ${JSON.stringify(raw)}`,
    );
    return DEFAULT_DRAIN_MS;
  }
  return seconds * 1000;
}

/**
 * Whether to announce on the local network. Off unless it says `true`.
 *
 * Only those two words are accepted. `yes`, `1` and `on` would each be
 * somebody's reasonable guess, and accepting a family of spellings means
 * eventually accepting one that was meant as a no -- a mistake that, in this
 * one direction, starts broadcasting a machine's address to a network where
 * nobody asked for it. A refusal names the two words and costs one restart.
 */
export function readAnnounce(raw: string | undefined, problems: string[]): boolean {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(
    `${SERVER_SETTINGS.announce.flag} must be true or false, not ${JSON.stringify(raw)}`,
  );
  return false;
}

const BAD_SERVER_TOKEN =
  'a pairing token the deployment sets must be at least ' +
  `${MIN_TOKEN_LENGTH} characters: set ${SERVER_SETTINGS.serverToken.env} or pass ` +
  `${SERVER_SETTINGS.serverToken.flag} (generate one with: openssl rand -base64 32), ` +
  'or set neither and let the server mint one';

/**
 * The pairing token the deployment set, or nothing.
 *
 * Absent is not a problem: it is the default, and it means the server mints
 * one on its first start exactly as it always has. Present but too short is
 * one problem with one message, because it is one mistake -- somebody put
 * something in a secret store that is not a secret -- and the message names
 * both the way out and the way back to the default.
 *
 * A blank env var arrives here as `undefined` rather than as an empty token,
 * because `settingValue` decided that for every setting: a line with nothing
 * after the `=` is a setting nobody set. That matters more here than
 * elsewhere. An empty string taken literally would be a server configured to
 * present no credential, and the failure would be an identity file written
 * with a token nothing can ever match.
 *
 * The setting's name is carried out with the value. `ensureServerIdentity`
 * refuses a file that disagrees with this token and has to say which variable
 * to change, and it lives in a package that does not own this name.
 */
export function readServerToken(
  raw: string | undefined,
  problems: string[],
): { readonly token: string; readonly setting: string } | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < MIN_TOKEN_LENGTH) {
    problems.push(BAD_SERVER_TOKEN);
    return undefined;
  }
  return { token: raw, setting: SERVER_SETTINGS.serverToken.env };
}

/**
 * The data root: what was configured, or the default under the account's home.
 */
export function readDataPath(
  raw: string | undefined,
  env: Environment,
  problems: string[],
): string | undefined {
  if (raw !== undefined) return readAbsolutePath(raw, DATA_PATH.flag, problems);
  return homeDefault(env, HOME_DIRECTORY, DATA_PATH, problems);
}

/**
 * The identity file: what was configured, or `server.json` in the directory
 * the data root defaults to.
 *
 * It used to have no default, on the argument that a location this
 * consequential is a deployment decision and a default would be picked once,
 * by accident, on the machine where it happened to work. What that bought in
 * practice was every installed server refusing to start: `agentplex setup`
 * mints the file at `$HOME/.agentplex/server.json` and records it for the hub
 * beside it, and nothing recorded it for the server. The default is that same
 * path, so the one a setup run chose is the one the server reads, and an
 * explicit setting still wins over it.
 *
 * Absolute for the reason every path here is, and with more at stake: a
 * relative path is resolved against whatever directory the process was left
 * in, so the same command run from two places is two identities, two tokens,
 * and a pairing that works from one shell and not the other.
 */
export function readIdentityPath(
  raw: string | undefined,
  env: Environment,
  problems: string[],
): string | undefined {
  const setting = SERVER_SETTINGS.serverIdentityFile;
  if (raw !== undefined) return readAbsolutePath(raw, setting.flag, problems);
  return homeDefault(env, join(HOME_DIRECTORY, IDENTITY_FILE_NAME), setting, problems);
}

/**
 * A path under the account's home, for a setting nobody set.
 *
 * `HOME` is read here rather than treated as a setting, because it is not one:
 * nothing in agentplex sets it, it is what the account the daemon runs as
 * already has, and both tiers of install arrange for it to be the right
 * answer. A user unit inherits the operator's; the system unit carries
 * `User=`, and systemd sets `HOME` from the account database, whose entry
 * `install.sh` created with the state directory as its home.
 *
 * When there is no home the configuration is refused rather than guessed at.
 * That refusal is the whole reason defaulting from an inherited variable is
 * safe: the failure mode of a wrong guess here is a server that writes its
 * state somewhere nobody named and loses it, and the failure mode of an absent
 * one is a sentence naming the setting, printed before anything starts.
 */
function homeDefault(
  env: Environment,
  relative: string,
  setting: Setting,
  problems: string[],
): string | undefined {
  const home = nonEmpty(env['HOME']);
  if (home === undefined) {
    problems.push(
      `${setting.env} is not set, and this machine has no HOME to default it from: ` +
        `set it or pass ${setting.flag} (an absolute path)`,
    );
    return undefined;
  }
  if (!isAbsolute(home)) {
    // Refused rather than resolved, for the reason every path here is: a
    // relative HOME would put this server's state under whatever directory a
    // unit file or an image left the process in, which is a different
    // directory the next time it starts.
    problems.push(
      `HOME is ${JSON.stringify(home)}, which is not an absolute path, so ${setting.env} has ` +
        `no default: set it or pass ${setting.flag}`,
    );
    return undefined;
  }
  return readAbsolutePath(join(home, relative), setting.flag, problems);
}

/**
 * The local server a hub pairs at boot, or `null` when the settings name none.
 *
 * The identity file is what makes an entry. A port on its own names nothing --
 * there is no file to read a token from -- and is refused rather than ignored,
 * because a setting that is read and does nothing is the shape of a typo that
 * costs somebody an afternoon. The path is absolute for the reason the server's
 * own identity path is: a relative one names a different file per working
 * directory, and a hub that read a different token than the server holds would
 * dial its own machine and be refused, with nothing pointing at the cause.
 */
export function readLocalServer(
  rawPath: string | undefined,
  rawPort: string | undefined,
  problems: string[],
): { readonly identityPath: string; readonly port: number } | null {
  const { localServerIdentityFile, localServerPort } = HUB_SETTINGS;
  if (rawPath === undefined) {
    if (rawPort !== undefined) {
      problems.push(
        `${localServerPort.flag} names a port for a local server, but no ` +
          `${localServerIdentityFile.flag} names its identity file`,
      );
    }
    return null;
  }
  const identityPath = readAbsolutePath(rawPath, localServerIdentityFile.flag, problems);
  const port = readPort(rawPort, localServerPort.flag, DEFAULT_SERVER_PORT, problems);
  return identityPath === undefined ? null : { identityPath, port };
}
