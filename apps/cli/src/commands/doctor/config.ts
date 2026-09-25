import { z } from 'zod';
import {
  DEFAULT_HUB_PORT,
  DEFAULT_SERVER_PORT,
  HUB_SETTINGS,
  SERVER_SETTINGS,
  nonEmpty,
  readAbsolutePath,
  readAbsolutePaths,
  readAnnounce,
  readDataPath,
  readDrainSeconds,
  readFlags,
  readHost,
  readIdentityPath,
  readLocalServer,
  readLogLevel,
  readPort,
  readServerToken,
  readTerminalCap,
  readTimezone,
  settingValue,
  usageLines,
  type Environment,
  type LogLevel,
  type Setting,
} from '@agentplex/node-shared';
import type { RecordedDeployment } from '../../installation/recorded-settings.js';
import { SYSTEM_STATE_DIR } from '../../installation/layout.js';

/**
 * The doctor's configuration: the settings the installer wrote, read the way
 * the daemons read them, so that the question it answers is what *this
 * deployment* can start. A doctor with flags of its own would be reporting on
 * a machine nobody is going to run. `main` calls this once and wires the
 * result.
 *
 * "The way the daemons read them" is literal. The tables and the parsers are
 * the ones in `@agentplex/node-shared` that the server and the hub read
 * through, so every flag either daemon accepts is one this accepts, and every
 * value either refuses is refused here. What starts from the settings file is
 * also the daemons' order: the file the units name, then this process's
 * environment over it, then flags over both -- the file is what the service
 * runs with, and the other two are how an operator asks "and what if".
 */

/**
 * The three things a machine can be, which is what `AGENTPLEX_ROLE` in the
 * settings file says. The doctor reads it to know which half to inspect: a
 * hub-only machine starts no sessions, mounts no stores and drives no
 * providers, and probing them anyway would report on a machine this
 * deployment never touches.
 */
export const ROLES = ['hub', 'server', 'both'] as const;
export type Role = (typeof ROLES)[number];

export interface ServerConfig {
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
   * The directories a client may browse under, absolute and deduplicated.
   *
   * Read here for the reason every other setting is: the doctor's question is
   * what *this deployment* can do, and browsing is one of the two things a
   * server can be configured into being unable to do at all. Empty is legal and
   * is the default -- a machine nobody gave a root to refuses every browse and
   * says so -- so the doctor reports the list rather than judging it.
   */
  readonly browseRoots: readonly string[];
  /**
   * Where this server keeps its own identity: its `serverId` and the pairing
   * token the user types into the hub.
   *
   * Absolute, for the reason the store paths are, and defaulted from the home
   * exactly as the server defaults it -- `readIdentityPath` carries both
   * arguments -- so that the file this reports on is the one the server would
   * open.
   */
  readonly identityPath: string;
  /**
   * The one directory the server writes into, defaulted as the server
   * defaults it. `inspectMachine` asks whether the server could create it or
   * write in it, because the server refuses to start when it cannot.
   */
  readonly dataPath: string;
  /**
   * The pairing token the deployment set, or undefined for one the server
   * mints. Parsed so that a token too short to be one is refused here as it is
   * at boot; nothing in the report prints it.
   */
  readonly serverToken: { readonly token: string; readonly setting: string } | undefined;
  /**
   * The zone a spawned child reports times in, or undefined to inherit.
   * Carried into the environment the preflight runs under, which is the one a
   * spawn would get.
   */
  readonly timezone: string | undefined;
  /** How long the server's shutdown waits for turns to end, in milliseconds. */
  readonly drainMs: number;
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

/**
 * What a hub needs before it can boot, as the settings name it.
 *
 * Three of these four are `null`-able, and that is the difference between this
 * half and the server half above. The server's paths all have defaults, so a
 * server half the doctor cannot settle is a machine with no home to default
 * from, which it refuses as the server does. A hub with no database file or no
 * client token is a machine in a state an operator asked about: it is the most
 * common way a half-finished hub fails, and the doctor's job is to print that
 * as a line rather than to answer a usage message instead of the report.
 *
 * A setting that is present and *malformed* -- a relative path, a port that is
 * not a number -- still stops the run with a usage error, the way it does for
 * every other setting in this program. Those are typos in what was typed, and
 * the reader that catches them says so better than a check could.
 */
export interface HubConfig {
  /** The port the hub serves the client and the API on. */
  readonly port: number;
  /** The SQLite file, absolute, or `null` when no setting names one. */
  readonly databaseFile: string | null;
  /**
   * The client credential, or `null` when no setting carries one.
   *
   * Carried as the word it is rather than as a length, because it is read the
   * way the hub reads it. It reaches no report line: `checkClientToken` in
   * `hub.ts` reads its length and returns a verdict that has nowhere to put a
   * value.
   */
  readonly clientToken: string | null;
  /**
   * The server on this machine the hub pairs at boot -- where it keeps its
   * identity and the port the hub dials -- when the settings name one, and
   * `null` for the hub that has none, which is most hubs.
   */
  readonly localServer: { readonly identityPath: string; readonly port: number } | null;
}

/**
 * Where the settings this configuration was read from came from.
 *
 * `file` is the settings file found, read or not, and `null` when there is
 * none -- a checkout or a container configured by environment alone.
 * `problems` is why it could not be read, when it could not: a finding for the
 * report, never a refusal, because the environment and the flags are still
 * there to read.
 */
export interface SettingsSource {
  readonly file: string | null;
  readonly problems: readonly string[];
}

/**
 * A union rather than a record with optional halves: in `--role=hub` there is
 * no server to inspect and in `--role=server` there is no hub, and the type
 * should be what makes each true. `both` is the one that carries the two, and
 * it is spelled out rather than folded into either so that neither half can be
 * reached on a role that does not run it.
 */
export type Config =
  | {
      readonly role: 'hub';
      readonly logLevel: LogLevel;
      readonly host: string;
      readonly settings: SettingsSource;
      readonly hub: HubConfig;
    }
  | {
      readonly role: 'server';
      readonly logLevel: LogLevel;
      readonly host: string;
      readonly settings: SettingsSource;
      readonly server: ServerConfig;
    }
  | {
      readonly role: 'both';
      readonly logLevel: LogLevel;
      readonly host: string;
      readonly settings: SettingsSource;
      readonly hub: HubConfig;
      readonly server: ServerConfig;
    };

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  /** Every problem, not the first: fixing one env var at a time is a bad loop. */
  | { readonly ok: false; readonly problems: readonly string[] };

export interface ConfigSources {
  /** Arguments after the node binary and script path. */
  readonly argv: readonly string[];
  readonly env: Environment;
  /**
   * The settings file the daemons' units name, as `readRecordedSettings` found
   * it. Absent is a machine with none, which is how a test and a container are
   * configured.
   */
  readonly recorded?: RecordedDeployment;
}

const NO_SETTINGS_FILE: RecordedDeployment = {
  scope: null,
  file: null,
  values: new Map(),
  problems: [],
};

/**
 * The one setting that is the doctor's own. Neither daemon reads it -- which
 * daemon runs is which program was started -- but the installer records it,
 * and it decides which half of this machine there is to inspect.
 */
const ROLE = { flag: '--role', env: 'AGENTPLEX_ROLE' } as const;

/**
 * Every setting the doctor reads: the role, which is its own, and then each
 * daemon's whole table.
 *
 * Each daemon's table, and not a list of the settings the doctor happens to
 * check, because the doctor is pointed at a deployment and a deployment is
 * whatever the daemons accept. A setting it read and never checked was once
 * argued against here as a flag an operator could type and learn nothing
 * from. That turned out to be the smaller cost: a doctor that refused
 * `--data-path` could not be pointed at the server that sets it at all.
 *
 * Both tables carry the log level and the host, so the list is made unique by
 * flag, or the usage would name each twice.
 */
const SETTINGS: readonly Setting[] = uniqueByFlag([
  ROLE,
  ...Object.values(HUB_SETTINGS),
  ...Object.values(SERVER_SETTINGS),
]);

function uniqueByFlag(settings: readonly Setting[]): readonly Setting[] {
  const byFlag = new Map<string, Setting>();
  for (const setting of settings) if (!byFlag.has(setting.flag)) byFlag.set(setting.flag, setting);
  return [...byFlag.values()];
}

const roleSchema = z.enum(ROLES);

export function loadDoctorConfig({
  argv,
  env,
  recorded = NO_SETTINGS_FILE,
}: ConfigSources): ConfigResult {
  const problems: string[] = [];

  const flags = readFlags(
    argv,
    SETTINGS.map((setting) => setting.flag),
  );
  if (!flags.ok) return { ok: false, problems: [...flags.problems] };

  const settings = deploymentEnvironment(recorded, env);
  const read = (setting: Setting): string | undefined =>
    settingValue(flags.values, settings, setting);

  const role = readRole(read(ROLE), problems);
  const logLevel = readLogLevel(read(SERVER_SETTINGS.logLevel), problems);
  const host = readHost(read(SERVER_SETTINGS.host), problems);
  const source: SettingsSource = { file: recorded.file, problems: recorded.problems };

  // Each half is read only on a role that runs it, and into the run's problems
  // only then. The settings file is one file: on a `both` machine inspected as
  // `--role=server` a relative `AGENTPLEX_DATABASE_FILE` is not this run's
  // problem, and a hub-only machine with no HOME is not refused over the
  // server's home defaults.
  const hub = readHubConfig(read, role === 'server' ? [] : problems);
  const server =
    role === 'hub' ? undefined : readServerConfig(read, flags.values, settings, problems);

  if (role === undefined || problems.length > 0) return { ok: false, problems };

  if (role === 'hub') return { ok: true, config: { role, logLevel, host, settings: source, hub } };

  if (server === undefined) return { ok: false, problems };
  if (role === 'server') {
    return { ok: true, config: { role, logLevel, host, settings: source, server } };
  }
  return { ok: true, config: { role, logLevel, host, settings: source, hub, server } };
}

/**
 * What the daemons would find in their environment: the settings file, with
 * this process's environment over it.
 *
 * A variable here that is blank does not hide the file's line. Everywhere else
 * in this program a blank variable is a setting nobody set, and a shell that
 * exported `AGENTPLEX_ROLE=` has not said anything about the role.
 *
 * `HOME` is the one variable taken from the tier rather than from this shell.
 * On the fleet tier the daemon runs as the service account and systemd sets
 * its home from the account database, which `install.sh` made the state
 * directory -- so that is what the server's defaults come from, whatever home
 * the operator or `sudo` is running this with.
 */
function deploymentEnvironment(recorded: RecordedDeployment, env: Environment): Environment {
  const merged: Record<string, string | undefined> = Object.fromEntries(recorded.values);
  for (const [key, value] of Object.entries(env)) {
    if (nonEmpty(value) !== undefined) merged[key] = value;
  }
  if (recorded.scope === 'system') merged['HOME'] = SYSTEM_STATE_DIR;
  return merged;
}

/**
 * The server's half, read through the server's own parsers, or `undefined`
 * when a path it needs could not be settled -- which is already a problem.
 */
function readServerConfig(
  read: (setting: Setting) => string | undefined,
  flags: ReadonlyMap<string, readonly string[]>,
  env: Environment,
  problems: string[],
): ServerConfig | undefined {
  const table = SERVER_SETTINGS;
  const paths = (setting: Setting): readonly string[] =>
    readAbsolutePaths(setting, flags.get(setting.flag), env[setting.env], problems);

  const port = readPort(
    read(table.serverPort),
    table.serverPort.flag,
    DEFAULT_SERVER_PORT,
    problems,
  );
  const storePaths = paths(table.storePath);
  const binPath = paths(table.binPath);
  const browseRoots = paths(table.browseRoot);
  const terminalCap = readTerminalCap(read(table.terminalCap), problems);
  const announce = readAnnounce(read(table.announce), problems);
  const timezone = readTimezone(read(table.timezone), problems);
  const drainMs = readDrainSeconds(read(table.drainSeconds), problems);
  const serverToken = readServerToken(read(table.serverToken), problems);
  const identityPath = readIdentityPath(read(table.serverIdentityFile), env, problems);
  const dataPath = readDataPath(read(table.dataPath), env, problems);

  if (identityPath === undefined || dataPath === undefined) return undefined;
  return {
    port,
    storePaths,
    binPath,
    browseRoots,
    identityPath,
    dataPath,
    serverToken,
    timezone,
    terminalCap,
    drainMs,
    announce,
  };
}

/**
 * The hub's half of the settings.
 *
 * The paths go through the same reader every other path here does, so a
 * relative one is a refusal and not a check that fails later with less to say.
 * An *absent* path is not a refusal: see `HubConfig` on why a hub with no
 * database file is a line in the report rather than a usage message.
 */
function readHubConfig(
  read: (setting: Setting) => string | undefined,
  problems: string[],
): HubConfig {
  const table = HUB_SETTINGS;
  const rawDatabase = read(table.databaseFile);
  const databaseFile =
    rawDatabase === undefined
      ? null
      : (readAbsolutePath(rawDatabase, table.databaseFile.flag, problems) ?? null);

  return {
    port: readPort(read(table.port), table.port.flag, DEFAULT_HUB_PORT, problems),
    databaseFile,
    clientToken: read(table.clientToken) ?? null,
    localServer: readLocalServer(
      read(table.localServerIdentityFile),
      read(table.localServerPort),
      problems,
    ),
  };
}

/** The settings this program reads, for a usage message. */
export function doctorUsage(): string {
  return ['Usage: agentplex doctor [options]', '', ...usageLines(SETTINGS)].join('\n');
}

/**
 * The role, which decides which half of the machine is inspected.
 */
function readRole(raw: string | undefined, problems: string[]): Role | undefined {
  if (raw === undefined) {
    problems.push(`no role: set ${ROLE.env} or pass ${ROLE.flag} (${ROLES.join(', ')})`);
    return undefined;
  }
  const result = roleSchema.safeParse(raw);
  if (!result.success) {
    problems.push(`unknown role ${JSON.stringify(raw)}: expected one of ${ROLES.join(', ')}`);
    return undefined;
  }
  return result.data;
}
