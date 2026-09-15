import { z } from 'zod';
import {
  DEFAULT_HUB_PORT,
  DEFAULT_SERVER_PORT,
  LOG_LEVELS,
  readAbsolutePath,
  readAbsolutePaths,
  readFlags,
  readPort,
  readSetting,
  settingValue,
  usageLines,
  type LogLevel,
  type Setting,
} from '@agentplex/node-shared';

/**
 * The doctor's configuration: the settings the installer wrote, read the way
 * the daemons read them, so that the question it answers is what *this
 * deployment* can start. A doctor with flags of its own would be reporting on
 * a machine nobody is going to run. `main` calls this once and wires the
 * result.
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
 * half and the server half above. A server with no identity file is a
 * configuration the doctor refuses to run against, because there is nothing to
 * inspect. A hub with no database file or no client token is a machine in a
 * state an operator asked about: it is the most common way a half-finished hub
 * fails, and the doctor's job is to print that as a line rather than to answer
 * a usage message instead of the report.
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
   * Where the server on this machine keeps its identity, when the settings name
   * one, and `null` for the hub that has none -- which is most hubs.
   */
  readonly localServerIdentityPath: string | null;
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
      readonly hub: HubConfig;
    }
  | {
      readonly role: 'server';
      readonly logLevel: LogLevel;
      readonly host: string;
      readonly server: ServerConfig;
    }
  | {
      readonly role: 'both';
      readonly logLevel: LogLevel;
      readonly host: string;
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
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/**
 * The terminal manager's own default, restated: it lives in `apps/server` now
 * and this program may not import it. AGX-100 replaces this configuration with
 * the doctor's own, and this constant goes with it.
 */
const DEFAULT_TERMINAL_CAP = 8;
/** Containers reach the process from outside their own loopback. */
const DEFAULT_HOST = '0.0.0.0';

const MISSING_IDENTITY_FILE =
  'the server role needs somewhere to keep its identity and pairing token: ' +
  'set AGENTPLEX_SERVER_IDENTITY_FILE or pass --server-identity-file (an absolute path)';

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
  role: { flag: '--role', env: 'AGENTPLEX_ROLE' },
  logLevel: { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' },
  host: { flag: '--host', env: 'AGENTPLEX_HOST' },
  hubPort: { flag: '--hub-port', env: 'AGENTPLEX_HUB_PORT' },
  databaseFile: { flag: '--database-file', env: 'AGENTPLEX_DATABASE_FILE' },
  clientToken: { flag: '--client-token', env: 'AGENTPLEX_CLIENT_TOKEN' },
  /**
   * The server on this machine, which the hub pairs at boot from the token in
   * that file. The hub's own settings carry a port beside it; this program does
   * not read one, because a setting it read and never checked would be a
   * setting an operator could type at a doctor and learn nothing from.
   */
  localServerIdentityFile: {
    flag: '--local-server-identity-file',
    env: 'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE',
  },
  serverPort: { flag: '--server-port', env: 'AGENTPLEX_SERVER_PORT' },
  /** Repeatable: a server may mount more than one store. */
  storePath: { flag: '--store-path', env: 'AGENTPLEX_STORE_PATH' },
  /** Repeatable, and ordered: the first directory holding a program wins. */
  binPath: { flag: '--bin-path', env: 'AGENTPLEX_BIN_PATH' },
  /** Repeatable: a machine may offer more than one place to browse. */
  browseRoot: { flag: '--browse-root', env: 'AGENTPLEX_BROWSE_ROOTS' },
  serverIdentityFile: {
    flag: '--server-identity-file',
    env: 'AGENTPLEX_SERVER_IDENTITY_FILE',
  },
  terminalCap: { flag: '--terminal-cap', env: 'AGENTPLEX_TERMINAL_CAP' },
  /**
   * Takes `true` or `false` rather than being a bare presence flag, which
   * `readFlags` would refuse anyway: every setting here has one value, and a
   * flag with none is a typo. It earns its keep beyond consistency, too -- an
   * image that sets `AGENTPLEX_ANNOUNCE=true` can be run quiet with
   * `--announce=false`, which a presence flag could never express.
   */
  announce: { flag: '--announce', env: 'AGENTPLEX_ANNOUNCE' },
} as const;

const roleSchema = z.enum(ROLES);
const logLevelSchema = z.enum(LOG_LEVELS);
const hostSchema = z.string().min(1);

export function loadDoctorConfig({ argv, env }: ConfigSources): ConfigResult {
  const problems: string[] = [];

  const flags = readFlags(
    argv,
    Object.values(SETTINGS).map((setting) => setting.flag),
  );
  if (!flags.ok) return { ok: false, problems: [...flags.problems] };

  const read = (setting: { readonly flag: string; readonly env: string }): string | undefined =>
    settingValue(flags.values, env, setting);

  const role = readRole(read(SETTINGS.role), problems);

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

  const browseRoots = readAbsolutePaths(
    SETTINGS.browseRoot,
    flags.values.get(SETTINGS.browseRoot.flag),
    env[SETTINGS.browseRoot.env],
    problems,
  );

  const terminalCap = readTerminalCap(read(SETTINGS.terminalCap), problems);

  const announce = readAnnounce(read(SETTINGS.announce), problems);

  const identityPath = readIdentityPath(read(SETTINGS.serverIdentityFile), role, problems);

  // A server-only machine runs no hub, so a hub setting that a `both` machine's
  // settings file left in the environment is read and then dropped rather than
  // held against the run: a relative `AGENTPLEX_DATABASE_FILE` is not this
  // machine's problem, and refusing to inspect a server over it would be.
  const hub = readHubConfig(read, role === 'server' ? [] : problems);

  if (role === undefined || problems.length > 0) return { ok: false, problems };

  if (role === 'hub') return { ok: true, config: { role, logLevel, host, hub } };

  if (identityPath === undefined) return { ok: false, problems: [MISSING_IDENTITY_FILE] };
  const server: ServerConfig = {
    port: serverPort,
    storePaths,
    binPath,
    browseRoots,
    identityPath,
    terminalCap,
    announce,
  };
  if (role === 'server') return { ok: true, config: { role, logLevel, host, server } };
  return { ok: true, config: { role, logLevel, host, hub, server } };
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
  const rawDatabase = read(SETTINGS.databaseFile);
  const databaseFile =
    rawDatabase === undefined
      ? null
      : (readAbsolutePath(rawDatabase, SETTINGS.databaseFile.flag, problems) ?? null);

  const rawLocalServer = read(SETTINGS.localServerIdentityFile);
  const localServerIdentityPath =
    rawLocalServer === undefined
      ? null
      : (readAbsolutePath(rawLocalServer, SETTINGS.localServerIdentityFile.flag, problems) ?? null);

  return {
    port: readPort(read(SETTINGS.hubPort), SETTINGS.hubPort.flag, DEFAULT_HUB_PORT, problems),
    databaseFile,
    clientToken: read(SETTINGS.clientToken) ?? null,
    localServerIdentityPath,
  };
}

/**
 * The identity file path, required by every role that runs a server, and read
 * the way the server reads it: absolute, because a relative path is resolved
 * against whatever directory the process was left in.
 */
function readIdentityPath(
  raw: string | undefined,
  role: Role | undefined,
  problems: string[],
): string | undefined {
  if (role === 'hub') return undefined;
  if (raw === undefined) {
    // A role that did not parse is reported already; it is still asked for an
    // identity file, so that the run which fixes the role does not then
    // discover a second missing setting.
    problems.push(MISSING_IDENTITY_FILE);
    return undefined;
  }
  return readAbsolutePath(raw, SETTINGS.serverIdentityFile.flag, problems);
}

/** The settings this program reads, for a usage message. */
export function doctorUsage(): string {
  return ['Usage: agentplex doctor [options]', '', ...usageLines(Object.values(SETTINGS))].join(
    '\n',
  );
}

/**
 * The role, which decides which half of the machine is inspected.
 */
function readRole(raw: string | undefined, problems: string[]): Role | undefined {
  if (raw === undefined) {
    problems.push(
      `no role: set ${SETTINGS.role.env} or pass ${SETTINGS.role.flag} (${ROLES.join(', ')})`,
    );
    return undefined;
  }
  const result = roleSchema.safeParse(raw);
  if (!result.success) {
    problems.push(`unknown role ${JSON.stringify(raw)}: expected one of ${ROLES.join(', ')}`);
    return undefined;
  }
  return result.data;
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
