import { delimiter, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_TERMINAL_CAP } from '../server/terminal-manager.js';
import { LOG_LEVELS, type LogLevel } from '../shared/logger.js';

/**
 * Configuration is a value produced from argv and env by a pure function, so
 * that every rule about what a role requires is testable without opening a
 * port. `main` calls this once and wires the result.
 */

/**
 * One deployable, three shapes. `both` is the homelab common case: a hub and a
 * session runner in one process, which is a wiring choice and not a third kind
 * of program.
 */
const ROLES = ['hub', 'server', 'both'] as const;
export type Role = (typeof ROLES)[number];

export interface HubConfig {
  readonly port: number;
  /**
   * The SQLite file, absolute and normalized. The hub is the only writer to it,
   * and the directory it sits in is the operator's to create and to back up.
   */
  readonly databaseFile: string;
}

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
   * operator's shell — while leaving the machine's own tools reachable, since
   * `git`, `ps` and everything a session shells out to come from there.
   *
   * Directories, never binaries. `CLAUDE_COMMAND` stays the bare name
   * `claude`, so the operation registry's rule that a program name is a name
   * and never a path holds without an exception carved out for configuration.
   */
  readonly binPath: readonly string[];
  /**
   * How many terminals this server may hold at once.
   *
   * Configuration rather than a constant because it is a statement about the
   * machine: the same build runs on a laptop that is also somebody's desktop
   * and on a box that exists to run agents. Reaching the cap is not an error —
   * the longest-unwatched terminal is closed and its session stays resumable —
   * so the setting trades memory against how often somebody's background
   * session has to be started again.
   */
  readonly terminalCap: number;
}

/**
 * A union rather than a record with optional halves: in `--role=server` there
 * is no database file to read, and the type should be what makes that true.
 *
 * `host` sits outside the halves because one process binds one interface, and
 * a hub and a server sharing a process share it.
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

const DEFAULT_HUB_PORT = 8080;
const DEFAULT_SERVER_PORT = 8081;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/** Containers reach the process from outside their own loopback. */
const DEFAULT_HOST = '0.0.0.0';

const MISSING_DATABASE_FILE =
  'the hub role needs a database: set AGENTPLEX_DATABASE_FILE or pass --database-file';

/**
 * Each setting has one flag and one env var. Flags win, because a flag is
 * typed by a person at the moment they mean it and an env var is inherited.
 *
 * Every setting is in here, including the interface to bind. One read
 * elsewhere — `process.env['AGENTPLEX_HOST']`, straight out of `main` — is one
 * setting with no flag, missing from `usage()`, and rejected by `readFlags` if
 * anyone tried to type it.
 */
const SETTINGS = {
  role: { flag: '--role', env: 'AGENTPLEX_ROLE' },
  logLevel: { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' },
  host: { flag: '--host', env: 'AGENTPLEX_HOST' },
  hubPort: { flag: '--hub-port', env: 'AGENTPLEX_HUB_PORT' },
  serverPort: { flag: '--server-port', env: 'AGENTPLEX_SERVER_PORT' },
  databaseFile: { flag: '--database-file', env: 'AGENTPLEX_DATABASE_FILE' },
  /** Repeatable: a server may mount more than one store. */
  storePath: { flag: '--store-path', env: 'AGENTPLEX_STORE_PATH' },
  /** Repeatable, and ordered: the first directory holding a program wins. */
  binPath: { flag: '--bin-path', env: 'AGENTPLEX_BIN_PATH' },
  terminalCap: { flag: '--terminal-cap', env: 'AGENTPLEX_TERMINAL_CAP' },
} as const;

/**
 * The value rules, as schemas rather than as hand-written checks.
 *
 * zod collects issues rather than throwing at the first one, which is the same
 * shape `ConfigResult` is built around. It reports them per setting: a port
 * that is both unparseable and out of range is still one thing to go and fix,
 * and a line per zod issue would read as more problems than there are.
 */
const roleSchema = z.enum(ROLES);
const logLevelSchema = z.enum(LOG_LEVELS);
const portSchema = z.coerce.number().int().min(1).max(65535);
const hostSchema = z.string().min(1);
/**
 * The database file: absolute, and normalized to one spelling.
 *
 * Relative is refused for the same reason a store path is. It would name
 * whatever directory the unit file, the shell, or the container image left the
 * process in, and a hub whose database follows the working directory is a hub
 * that silently comes up empty somewhere and migrates a second file. `resolve`
 * on an already-absolute path never consults the working directory; it
 * collapses `..` and a trailing separator so that one file has one name.
 */
const databaseFileSchema = z
  .string()
  .refine((value) => isAbsolute(value))
  .transform((value) => resolve(value));

export function loadConfig({ argv, env }: ConfigSources): ConfigResult {
  const flags = readFlags(argv);
  if (!flags.ok) return flags;

  const problems: string[] = [];
  const read = (setting: { flag: string; env: string }): string | undefined =>
    flags.values.get(setting.flag)?.at(-1) ?? nonEmpty(env[setting.env]);

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

  const hubPort = readPort(
    read(SETTINGS.hubPort),
    SETTINGS.hubPort.flag,
    DEFAULT_HUB_PORT,
    problems,
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

  const terminalCap = readTerminalCap(read(SETTINGS.terminalCap), problems);

  const databaseFile = readDatabaseFile(read(SETTINGS.databaseFile), role, problems);

  if (role === undefined || problems.length > 0) return { ok: false, problems };

  const server: ServerConfig = { port: serverPort, storePaths, binPath, terminalCap };
  if (role === 'server') return { ok: true, config: { role, logLevel, host, server } };

  if (databaseFile === undefined) return { ok: false, problems: [MISSING_DATABASE_FILE] };
  const hub: HubConfig = { port: hubPort, databaseFile };

  return role === 'hub'
    ? { ok: true, config: { role, logLevel, host, hub } }
    : { ok: true, config: { role, logLevel, host, hub, server } };
}

/** The flags this build understands, for a usage message. */
export function usage(): string {
  const lines = Object.values(SETTINGS).map(({ flag, env }) => `  ${flag.padEnd(16)} (${env})`);
  return ['Usage: agentplexd [options]', '', ...lines].join('\n');
}

type FlagsResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Accepts `--flag=value` and `--flag value`, and refuses anything else.
 *
 * An unknown flag is a failure rather than a shrug: silently ignoring
 * `--databse-file` would start the process with the wrong database.
 *
 * `node:util.parseArgs` handles both forms and rejects unknown options, and it
 * was tried here. Under `strict: true` it throws on the first unknown option,
 * which is the one thing this function must not do: the whole point of
 * `ConfigResult` is that a bad invocation reports every problem at once.
 *
 * Every occurrence is kept, because one flag is a list: `--store-path` twice
 * means two stores. For the settings that are single-valued the last one wins,
 * which is the shell convention and the one a wrapper script relies on when it
 * appends an override to a command line it did not write.
 */
function readFlags(argv: readonly string[]): FlagsResult {
  const known = new Set<string>(Object.values(SETTINGS).map((setting) => setting.flag));
  const values = new Map<string, string[]>();
  const problems: string[] = [];
  const add = (flag: string, value: string): void => {
    const existing = values.get(flag);
    if (existing === undefined) values.set(flag, [value]);
    else existing.push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (!known.has(flag)) {
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    if (separator !== -1) {
      add(flag, argument.slice(separator + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      problems.push(`${flag} needs a value`);
      continue;
    }
    add(flag, next);
    index += 1;
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}

/** An absent setting takes its default; a present one has to parse. */
function readSetting<S extends z.ZodType>(
  schema: S,
  raw: string | undefined,
  fallback: z.infer<S>,
  report: (raw: string) => void,
): z.infer<S> {
  if (raw === undefined) return fallback;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  report(raw);
  return fallback;
}

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
 * mean a server that accepts sessions and can never run one — a configuration
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
 * The hub's database, or the reason there isn't one.
 *
 * There is no default. A path invented here would be a file somebody has to
 * find later in order to back it up, and inventing one under the working
 * directory is how a hub ends up with two databases and no error.
 */
function readDatabaseFile(
  raw: string | undefined,
  role: Role | undefined,
  problems: string[],
): string | undefined {
  if (raw === undefined) {
    // Only a server is allowed to have none. A role that did not parse is
    // reported already; it is still asked for a database, because the run that
    // fixes the role should not then discover a second missing setting.
    if (role !== 'server') problems.push(MISSING_DATABASE_FILE);
    return undefined;
  }

  const result = databaseFileSchema.safeParse(raw);
  if (!result.success) {
    problems.push(
      `${SETTINGS.databaseFile.flag} must be an absolute path, not ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  return result.data;
}

function readPort(
  raw: string | undefined,
  flag: string,
  fallback: number,
  problems: string[],
): number {
  return readSetting(portSchema, raw, fallback, (offending) =>
    problems.push(
      `${flag} must be a port number between 1 and 65535, not ${JSON.stringify(offending)}`,
    ),
  );
}

/**
 * An ordered list of absolute directories, from repeated flags or from one
 * delimiter-separated env var. Both list settings are this: the store roots to
 * watch, and the directories to resolve a program in.
 *
 * Flags replace the environment rather than adding to it, for the same reason
 * they win everywhere else: a person listing directories on a command line is
 * saying which ones, not which extra ones. The env var takes a `PATH`-shaped
 * list because a container is configured with environment and nothing else,
 * and mounting two volumes must not require rewriting the command.
 *
 * A relative path is refused rather than resolved: it would mean whatever
 * directory the unit file, the shell, or the container image happened to leave
 * the process in. A store that moves when the working directory moves is a
 * store whose identity file is somewhere nobody meant, and a bin directory
 * that moves is the silent resolution failure this list exists to end.
 */
function readAbsolutePaths(
  setting: { readonly flag: string },
  flagValues: readonly string[] | undefined,
  envValue: string | undefined,
  problems: string[],
): readonly string[] {
  const fromFlags = flagValues !== undefined;
  const raw = flagValues ?? (envValue ?? '').split(delimiter);

  const paths: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      // An empty segment in the env var is a trailing delimiter, which is a
      // typo with an obvious meaning. A flag given no value is a person asking
      // for something that does not exist, and gets told so.
      if (fromFlags) problems.push(`${setting.flag} needs a path`);
      continue;
    }

    if (!isAbsolute(trimmed)) {
      problems.push(`${setting.flag} must be an absolute path, not ${JSON.stringify(trimmed)}`);
      continue;
    }

    // `resolve` on an already-absolute path never consults the working
    // directory; it collapses `..` and a trailing separator so that the same
    // directory spelled two ways is listed once rather than twice.
    const normalized = resolve(trimmed);
    if (!paths.includes(normalized)) paths.push(normalized);
  }

  return paths;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
