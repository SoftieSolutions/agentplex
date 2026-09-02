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
export type Role = 'hub' | 'server' | 'both';

export interface HubConfig {
  readonly port: number;
  /** The one connection string; the hub is the only writer to this database. */
  readonly databaseUrl: string;
}

export interface ServerConfig {
  /** The port the hub dials. A server dials out to nothing. */
  readonly port: number;
}

/**
 * A union rather than a record with optional halves: in `--role=server` there
 * is no database url to read, and the type should be what makes that true.
 */
export type Config =
  | { readonly role: 'hub'; readonly logLevel: LogLevel; readonly hub: HubConfig }
  | { readonly role: 'server'; readonly logLevel: LogLevel; readonly server: ServerConfig }
  | {
      readonly role: 'both';
      readonly logLevel: LogLevel;
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

const ROLES: readonly Role[] = ['hub', 'server', 'both'];

const MISSING_DATABASE_URL =
  'the hub role needs a database: set AGENTPLEX_DATABASE_URL or pass --database-url';

/**
 * Each setting has one flag and one env var. Flags win, because a flag is
 * typed by a person at the moment they mean it and an env var is inherited.
 */
const SETTINGS = {
  role: { flag: '--role', env: 'AGENTPLEX_ROLE' },
  logLevel: { flag: '--log-level', env: 'AGENTPLEX_LOG_LEVEL' },
  hubPort: { flag: '--hub-port', env: 'AGENTPLEX_HUB_PORT' },
  serverPort: { flag: '--server-port', env: 'AGENTPLEX_SERVER_PORT' },
  databaseUrl: { flag: '--database-url', env: 'AGENTPLEX_DATABASE_URL' },
} as const;

export function loadConfig({ argv, env }: ConfigSources): ConfigResult {
  const flags = readFlags(argv);
  if (!flags.ok) return flags;

  const problems: string[] = [];
  const read = (setting: { flag: string; env: string }): string | undefined =>
    flags.values.get(setting.flag) ?? nonEmpty(env[setting.env]);

  const role = readRole(read(SETTINGS.role), problems);
  const logLevel = readLogLevel(read(SETTINGS.logLevel), problems);

  const needsHub = role !== 'server';

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

  const databaseUrl = read(SETTINGS.databaseUrl);
  if (needsHub && databaseUrl === undefined) problems.push(MISSING_DATABASE_URL);

  if (role === undefined || problems.length > 0) return { ok: false, problems };

  const server: ServerConfig = { port: serverPort };
  if (role === 'server') return { ok: true, config: { role, logLevel, server } };

  if (databaseUrl === undefined) return { ok: false, problems: [MISSING_DATABASE_URL] };
  const hub: HubConfig = { port: hubPort, databaseUrl };

  return role === 'hub'
    ? { ok: true, config: { role, logLevel, hub } }
    : { ok: true, config: { role, logLevel, hub, server } };
}

/** The flags this build understands, for a usage message. */
export function usage(): string {
  const lines = Object.values(SETTINGS).map(({ flag, env }) => `  ${flag.padEnd(16)} (${env})`);
  return ['Usage: agentplexd [options]', '', ...lines].join('\n');
}

type FlagsResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Accepts `--flag=value` and `--flag value`, and refuses anything else.
 *
 * An unknown flag is a failure rather than a shrug: silently ignoring
 * `--databse-url` would start the process with the wrong database.
 */
function readFlags(argv: readonly string[]): FlagsResult {
  const known = new Set<string>(Object.values(SETTINGS).map((setting) => setting.flag));
  const values = new Map<string, string>();
  const problems: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (!known.has(flag)) {
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    if (separator !== -1) {
      values.set(flag, argument.slice(separator + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      problems.push(`${flag} needs a value`);
      continue;
    }
    values.set(flag, next);
    index += 1;
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}

function readRole(raw: string | undefined, problems: string[]): Role | undefined {
  if (raw === undefined) {
    problems.push(
      `no role: set ${SETTINGS.role.env} or pass ${SETTINGS.role.flag} (${ROLES.join(', ')})`,
    );
    return undefined;
  }
  const role = ROLES.find((candidate) => candidate === raw);
  if (role === undefined) {
    problems.push(`unknown role ${JSON.stringify(raw)}: expected one of ${ROLES.join(', ')}`);
  }
  return role;
}

function readLogLevel(raw: string | undefined, problems: string[]): LogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    problems.push(
      `unknown log level ${JSON.stringify(raw)}: expected one of ${LOG_LEVELS.join(', ')}`,
    );
    return DEFAULT_LOG_LEVEL;
  }
  return level;
}

function readPort(
  raw: string | undefined,
  flag: string,
  fallback: number,
  problems: string[],
): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${flag} must be a port number between 1 and 65535, not ${JSON.stringify(raw)}`);
    return fallback;
  }
  return port;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
