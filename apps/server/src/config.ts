import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_SERVER_PORT,
  LOG_LEVELS,
  MIN_TOKEN_LENGTH,
  nonEmpty,
  readAbsolutePath,
  readAbsolutePaths,
  readFlags,
  readPort,
  readSetting,
  settingValue,
  usageLines,
  type LogLevel,
} from '@agentplex/node-shared';
import type { ConfiguredToken } from '@agentplex/providers';
import { DEFAULT_DRAIN_MS } from './drain.js';
import { DEFAULT_TERMINAL_CAP } from './terminal-manager.js';

/**
 * The server's configuration: a value produced from argv and env by a pure
 * function, so that every rule about what the server requires is testable
 * without opening a port. `main` calls this once and wires the result.
 *
 * There is no `--role`. Which daemon runs is which program was started, and
 * this is the server. The env var names keep their `AGENTPLEX_` prefix and
 * their meanings, so a settings file written by an installer that predates the
 * split still starts this daemon: it reads the keys it needs out of that file,
 * and a key the hub owns is not an error, because a setting the server never
 * reads is a setting it never sees.
 */

export interface ServerConfig {
  readonly logLevel: LogLevel;
  /** The interface to bind, a setting like any other. */
  readonly host: string;
  /** The port the hub dials. A server dials out to nothing. */
  readonly port: number;
  /**
   * The store roots this server has mounted, absolute and deduplicated.
   *
   * v1 hardwired `~/.claude/projects`; a store is a mounted volume here, so
   * where it is has to be something the deployment says. Empty is legal: a
   * server whose volume is not mounted yet reports no stores rather than
   * refusing to start, and the hub is told the truth either way.
   */
  readonly storePaths: readonly string[];
  /**
   * The directories a spawned program is looked for in, absolute, in search
   * order, and deduplicated.
   *
   * Empty is legal and means what it always meant: the child inherits this
   * process's PATH. Recorded directories are searched ahead of it, which is
   * what makes a bare program name resolve the same under systemd as in the
   * operator's shell -- while leaving the machine's own tools reachable, since
   * `git`, `ps` and everything a session shells out to come from there.
   *
   * Directories, never binaries. `CLAUDE_COMMAND` stays the bare name
   * `claude`, so the operation registry's rule that a program name is a name
   * and never a path holds without an exception carved out for configuration.
   */
  readonly binPath: readonly string[];
  /**
   * Where this server keeps its own identity: its `serverId` and the pairing
   * token the user types into the hub.
   *
   * Required, and absolute, for the reason the store paths are: this file is
   * the difference between a server the hub recognises and one it has never
   * met, and a path resolved against whatever directory a unit file or a
   * container image happened to leave the process in would silently become a
   * different file -- at which point the server mints a new identity, the
   * pairing stops working, and nothing says why.
   *
   * There is no default. A location this consequential is a deployment
   * decision, and a default would be picked once, by accident, on the machine
   * where it happened to work.
   */
  readonly identityPath: string;
  /**
   * The pairing token the deployment set, with the name of the setting that
   * set it, or undefined to let the server mint its own on first start.
   *
   * Undefined is the default and stays the default: minting is right wherever
   * there is a disk that outlives the process and somebody who can read a file
   * off it, and that is most machines. What it cannot serve is the deployment
   * that has neither -- a container whose filesystem goes at the next deploy, a
   * CI job nobody will shell into -- where the orchestrator already holds the
   * secret and expects the process to use it. A server that mints its own there
   * comes up with a token nobody knows, and the pairing has to be redone every
   * restart.
   *
   * A minimum length is enforced rather than trusted, for the reason the hub's
   * client token enforces one and against the same number: what arrives here is
   * whatever somebody put in a secret store, and a token a CSPRNG did not mint
   * is only as good as the person who chose it.
   */
  readonly serverToken: ConfiguredToken | undefined;
  /**
   * The one directory this server writes into: absolute, created at boot, and
   * refused rather than worked around when it cannot be.
   *
   * `data-root.ts` holds the rule for what may go under it and the argument
   * for every part of that -- including why the identity file above did not
   * fold into it, and why an absent store path is reported while an absent
   * data root stops the start. This is only where the path comes from.
   *
   * It has a default, which the identity file deliberately does not, and the
   * difference is what the two are for. The identity file is the machine's
   * name and secret, and a default would be a machine paired under a file
   * nobody chose. The data root is a working directory: every install already
   * has a place for one, the default is that place, and being wrong about it
   * costs a move rather than an identity.
   */
  readonly dataPath: string;
  /**
   * The zone every child this server spawns reports times in, or undefined to
   * inherit whatever the unit gave this process.
   *
   * A setting rather than a line in a unit file for the reason this file opens
   * with: configuration is a value produced from argv and env by a pure
   * function, and a zone an operator can only choose by editing a systemd unit
   * is a setting outside that function.
   *
   * It reaches a child and nothing else. The one time this server formats a
   * time for a human is the log timestamp, which is ISO-8601 in UTC and stays
   * that way: a log line is read beside a hub's and beside another server's,
   * and being comparable is the whole value of the stamp -- the same argument
   * that has the hub stamping what it receives with its own clock rather than
   * with the one the report came from. What a zone changes is the answer an
   * agent gives to "what day is it", and that answer is made in a child.
   */
  readonly timezone: string | undefined;
  /**
   * How many terminals this server may hold at once.
   *
   * Configuration rather than a constant because it is a statement about the
   * machine: the same build runs on a laptop that is also somebody's desktop
   * and on a box that exists to run agents. Reaching the cap is not an error --
   * the longest-unwatched terminal is closed and its session stays resumable --
   * so the setting trades memory against how often somebody's background
   * session has to be started again.
   */
  readonly terminalCap: number;
  /**
   * How long shutdown waits for the turns this server is holding to end, in
   * milliseconds.
   *
   * Configuration rather than a constant because the number that has to be
   * right is not this one on its own -- it is this one against the unit's
   * `TimeoutStopSec`, and only the thing that wrote the unit knows what that
   * says. `install.sh` renders both from one pair, so a machine installed by it
   * has a single number and a margin; the default is what a checkout, an image
   * and anything else without such a unit gets.
   *
   * Zero is legal and is not the same as no drain: a server told to wait for
   * nothing still closes at a boundary whatever is already at one, which is
   * strictly more than the kill it replaces. A negative number is refused,
   * because it could only ever be a typo.
   */
  readonly drainMs: number;
  /**
   * Whether this server broadcasts a UDP beacon saying it exists.
   *
   * Off unless the operator turns it on. Announcing is a fact about this
   * machine handed to everyone on the network it is attached to, and the same
   * build runs on the box in the basement -- where discovery is the whole
   * convenience -- and on a laptop on a cafe wifi, where it is not. A default
   * cannot be right for both, and the direction that does not over-claim is
   * the quiet one. The hub's side of this has no such cost and is
   * unconditional: it listens whether or not anything is announcing.
   *
   * What it buys is one line of a form. A beacon carries no token and proves
   * nothing; pairing remains the user typing this server's token into the hub.
   */
  readonly announce: boolean;
}

export type ServerConfigResult =
  | { readonly ok: true; readonly config: ServerConfig }
  /** Every problem, not the first: fixing one env var at a time is a bad loop. */
  | { readonly ok: false; readonly problems: readonly string[] };

export interface ServerConfigSources {
  /** Arguments after the node binary and script path. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/** Containers reach the process from outside their own loopback. */
const DEFAULT_HOST = '0.0.0.0';

const MISSING_IDENTITY_FILE =
  'the server role needs somewhere to keep its identity and pairing token: ' +
  'set AGENTPLEX_SERVER_IDENTITY_FILE or pass --server-identity-file (an absolute path)';

const BAD_SERVER_TOKEN =
  'a pairing token the deployment sets must be at least ' +
  `${MIN_TOKEN_LENGTH} characters: set AGENTPLEX_SERVER_TOKEN or pass --server-token ` +
  '(generate one with: openssl rand -base64 32), or set neither and let the server mint one';

/**
 * The data root's setting, named here and exported because the module that
 * owns the directory has to name it too: every refusal `ensureDataRoot`
 * produces tells the operator which setting to change, and a second spelling
 * of it there would be a message pointing at a variable that does not exist.
 */
export const DATA_PATH = { flag: '--data-path', env: 'AGENTPLEX_DATA_PATH' } as const;

/**
 * What the data root falls back to under the account's home.
 *
 * The same directory an install already owns: a plain `install.sh` run puts
 * the prefix at `$HOME/.agentplex` and makes that the state directory too, so
 * on the tier most machines are, the default is where everything else about
 * agentplex on that machine already is.
 *
 * On the `--system` tier the account's home is `/var/lib/agentplex` -- the
 * state directory the installer created for it, not `/opt/agentplex`, which is
 * root-owned runtime the account may not write to. Defaulting off the home
 * rather than off `AGENTPLEX_PREFIX` is what keeps those two apart: the prefix
 * is where the programs live and the home is where the account's own files go,
 * and AGX-158 separated them on purpose.
 */
const DEFAULT_DATA_DIRECTORY = '.agentplex';

const MISSING_DATA_PATH =
  'a server needs one directory of its own to write into, and this machine has no HOME ' +
  'to default one from: set AGENTPLEX_DATA_PATH or pass --data-path (an absolute path)';

/**
 * Each setting has one flag and one env var. Flags win, because a flag is
 * typed by a person at the moment they mean it and an env var is inherited.
 *
 * Every setting is in here, including the interface to bind. One read
 * elsewhere -- `process.env['AGENTPLEX_HOST']`, straight out of `main` -- is one
 * setting with no flag, missing from `usage()`, and rejected by `readFlags` if
 * anyone tried to type it.
 */
const SETTINGS = {
  logLevel: { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' },
  host: { flag: '--host', env: 'AGENTPLEX_HOST' },
  serverPort: { flag: '--server-port', env: 'AGENTPLEX_SERVER_PORT' },
  /** Repeatable: a server may mount more than one store. */
  storePath: { flag: '--store-path', env: 'AGENTPLEX_STORE_PATH' },
  /** Repeatable, and ordered: the first directory holding a program wins. */
  binPath: { flag: '--bin-path', env: 'AGENTPLEX_BIN_PATH' },
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
} as const;

const logLevelSchema = z.enum(LOG_LEVELS);
const hostSchema = z.string().min(1);

export function loadServerConfig({ argv, env }: ServerConfigSources): ServerConfigResult {
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

  const serverPort = readPort(
    read(SETTINGS.serverPort),
    SETTINGS.serverPort.flag,
    DEFAULT_SERVER_PORT,
    problems,
  );

  const storePaths = readAbsolutePaths(
    SETTINGS.storePath,
    flags.values.get(SETTINGS.storePath.flag),
    env[SETTINGS.storePath.env],
    problems,
  );

  const binPath = readAbsolutePaths(
    SETTINGS.binPath,
    flags.values.get(SETTINGS.binPath.flag),
    env[SETTINGS.binPath.env],
    problems,
  );

  const timezone = readTimezone(read(SETTINGS.timezone), problems);

  const terminalCap = readTerminalCap(read(SETTINGS.terminalCap), problems);

  const drainMs = readDrainSeconds(read(SETTINGS.drainSeconds), problems);

  const announce = readAnnounce(read(SETTINGS.announce), problems);

  const identityPath = readIdentityPath(read(SETTINGS.serverIdentityFile), problems);

  const serverToken = readServerToken(read(SETTINGS.serverToken), problems);

  const dataPath = readDataPath(read(SETTINGS.dataPath), env, problems);

  if (identityPath === undefined || dataPath === undefined || problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    config: {
      logLevel,
      host,
      port: serverPort,
      storePaths,
      binPath,
      identityPath,
      serverToken,
      dataPath,
      timezone,
      terminalCap,
      drainMs,
      announce,
    },
  };
}

/**
 * The data root: what was configured, or the default under the account's home.
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
function readDataPath(
  raw: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[],
): string | undefined {
  if (raw !== undefined) return readAbsolutePath(raw, SETTINGS.dataPath.flag, problems);

  const home = nonEmpty(env['HOME']);
  if (home === undefined) {
    problems.push(MISSING_DATA_PATH);
    return undefined;
  }
  if (!isAbsolute(home)) {
    // Refused rather than resolved, for the reason every path here is: a
    // relative HOME would put this server's state under whatever directory a
    // unit file or an image left the process in, which is a different
    // directory the next time it starts.
    problems.push(
      `HOME is ${JSON.stringify(home)}, which is not an absolute path, so there is no default ` +
        `data root: set ${SETTINGS.dataPath.env} or pass ${SETTINGS.dataPath.flag}`,
    );
    return undefined;
  }

  return readAbsolutePath(join(home, DEFAULT_DATA_DIRECTORY), SETTINGS.dataPath.flag, problems);
}

/**
 * The identity file path, required by the server.
 *
 * Absolute for the reason the store paths are, and with more at stake: a
 * relative path is resolved against whatever directory the process was left
 * in, so the same command run from two places is two identities, two tokens,
 * and a pairing that works from one shell and not the other.
 */
function readIdentityPath(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined) {
    problems.push(MISSING_IDENTITY_FILE);
    return undefined;
  }
  return readAbsolutePath(raw, SETTINGS.serverIdentityFile.flag, problems);
}

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
function readServerToken(raw: string | undefined, problems: string[]): ConfiguredToken | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < MIN_TOKEN_LENGTH) {
    problems.push(BAD_SERVER_TOKEN);
    return undefined;
  }
  return { token: raw, setting: SETTINGS.serverToken.env };
}

/**
 * The flags this program understands, and the first line, which had to change.
 *
 * It said `Usage: agentplex <daemon> [options]`, and that was a command line
 * nobody can type any more: the daemons stopped being subcommands, no
 * `agentplex-<daemon>` reaches anybody's PATH, and the one bin there is answers
 * the word by explaining what a daemon is. A usage naming an invocation that
 * does not exist is worse than no usage -- it is the one line an operator would
 * copy.
 *
 * So it names the invocation that does exist, which is the one systemd uses:
 * an interpreter and this program's compiled entry, by path. `apps/<daemon>/
 * dist/main.js` is that path relative to wherever the package is, and it is the
 * same expression in a checkout, in the runtime image and under
 * `<prefix>/lib/node_modules` alike, because packaging keeps the workspace
 * layout on purpose. The absolute prefix is not guessed at: this process knows
 * where it was started from and an operator reading a usage message does not
 * need it restated.
 *
 * The three lines above the usage are what somebody who typed `--help` at this
 * file was actually asking. They wanted to run it, and the answer is that
 * something else runs it: `agentplex start` on an installed machine, `pnpm -C
 * apps/<daemon> start` in a checkout.
 */
export function serverUsage(): string {
  return [
    'agentplex server is a daemon, not a command: nothing puts it on a PATH.',
    'On an installed machine systemd runs it from agentplex-server.service, and',
    '`agentplex start` is what enables and starts that unit; `agentplex status` says',
    'whether it is running. In a checkout, `pnpm -C apps/server start`.',
    '',
    'It reads what this machine can run once, at startup, and reports that to every',
    'hub. After installing a provider or logging one in, `systemctl reload',
    'agentplex-server` -- a SIGHUP -- makes it read again and republish, without',
    'dropping the sessions it is holding.',
    '',
    'Usage: <node> apps/server/dist/main.js [options]',
    '',
    '  Each option below is also a setting, and the unit reads every one of them',
    '  from the EnvironmentFile the installer wrote.',
    '',
    ...usageLines(Object.values(SETTINGS)),
  ].join('\n');
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
function readTimezone(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined) return undefined;

  const named = zoneNamed(raw);
  if (named === undefined) {
    problems.push(
      `${SETTINGS.timezone.flag} must be a timezone this machine knows, like Europe/Madrid ` +
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
function readTerminalCap(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_TERMINAL_CAP;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 1) {
    problems.push(
      `${SETTINGS.terminalCap.flag} must be a whole number of terminals, at least 1, not ${JSON.stringify(raw)}`,
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
function readDrainSeconds(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_DRAIN_MS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) {
    problems.push(
      `${SETTINGS.drainSeconds.flag} must be a whole number of seconds, none of them negative, not ${JSON.stringify(raw)}`,
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
function readAnnounce(raw: string | undefined, problems: string[]): boolean {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${SETTINGS.announce.flag} must be true or false, not ${JSON.stringify(raw)}`);
  return false;
}
