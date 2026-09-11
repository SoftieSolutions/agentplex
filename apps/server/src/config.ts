import { z } from 'zod';
import {
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
} from '@agentplex/node-shared';
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

  const terminalCap = readTerminalCap(read(SETTINGS.terminalCap), problems);

  const announce = readAnnounce(read(SETTINGS.announce), problems);

  const identityPath = readIdentityPath(read(SETTINGS.serverIdentityFile), problems);

  if (identityPath === undefined || problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      logLevel,
      host,
      port: serverPort,
      storePaths,
      binPath,
      identityPath,
      terminalCap,
      announce,
    },
  };
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
    'Usage: <node> apps/server/dist/main.js [options]',
    '',
    '  Each option below is also a setting, and the unit reads every one of them',
    '  from the EnvironmentFile the installer wrote.',
    '',
    ...usageLines(Object.values(SETTINGS)),
  ].join('\n');
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
