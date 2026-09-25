import {
  DEFAULT_SERVER_PORT,
  SERVER_SETTINGS,
  readAbsolutePaths,
  readAnnounce,
  readDataPath,
  readDrainSeconds,
  readFlags,
  readHost,
  readIdentityPath,
  readLogLevel,
  readPort,
  readServerToken,
  readTerminalCap,
  readTimezone,
  settingValue,
  usageLines,
  type LogLevel,
  type Setting,
} from '@agentplex/node-shared';
import type { ConfiguredToken } from '@agentplex/providers';

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
   * The directories a client may browse under, absolute and deduplicated.
   *
   * This is the whole of what makes a directory on a frame something other than
   * the `{ cwd }` field the v2 rule forbade: a browse request is refused unless
   * its real path sits under one of these, and nothing on the wire can add to
   * the list. See `directory-browse.ts` for the rule and
   * `packages/protocol/src/directory.ts` for the amendment and its argument.
   *
   * Empty is legal and is the default, and it means browsing is refused --
   * every request, with that as the reason. That is the direction that does not
   * over-claim: what a root grants is a list of this machine's files to anybody
   * who can reach a paired hub, and a build that picked one by default would be
   * a build that decided that for an operator who never read this line. A
   * machine where nobody has set one is a machine where the projects screen
   * says so rather than one that quietly shows `/`.
   *
   * Separate from the store paths on purpose, though the two often name the
   * same directory. A store is a provider's volume this server watches; a
   * browse root is where a person may look for a checkout to work in, and on
   * most machines that is a home directory or a `code` folder with no
   * transcripts in it at all. Deriving one from the other would make widening
   * a browse root a change to what this server watches.
   */
  readonly browseRoots: readonly string[];
  /**
   * Where this server keeps its own identity: its `serverId` and the pairing
   * token the user types into the hub.
   *
   * Absolute, for the reason the store paths are: this file is the difference
   * between a server the hub recognises and one it has never met, and a path
   * resolved against whatever directory a unit file or a container image
   * happened to leave the process in would silently become a different file --
   * at which point the server mints a new identity, the pairing stops working,
   * and nothing says why.
   *
   * It defaults to `$HOME/.agentplex/server.json`, which is where `agentplex
   * setup` mints it, so a machine set up the ordinary way starts the server it
   * paired. `readIdentityPath` carries the argument; the `--system` installer
   * records the path outright rather than leaning on the default.
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
   * It defaults to the directory the identity file defaults into. The two are
   * still two settings, for the reason `data-root.ts` gives: the identity file
   * is a coordinate three programs agree on, and the data root is this
   * server's alone. That on an ordinary install one sits inside the other is
   * where an install puts things, not a rule either setting depends on.
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

/**
 * The table and every rule for what a value may be live in
 * `@agentplex/node-shared`'s `daemon-settings.ts`, because the doctor reads
 * this same table to report on the deployment this server runs in, and a
 * third copy of a rule is a rule that drifts. What is this program's own is
 * which of them it reads, and that every one of them is required to parse.
 */
const SETTINGS = SERVER_SETTINGS;

export function loadServerConfig({ argv, env }: ServerConfigSources): ServerConfigResult {
  const problems: string[] = [];

  const flags = readFlags(
    argv,
    Object.values(SETTINGS).map((setting) => setting.flag),
  );
  if (!flags.ok) return { ok: false, problems: [...flags.problems] };

  const read = (setting: Setting): string | undefined => settingValue(flags.values, env, setting);

  const logLevel = readLogLevel(read(SETTINGS.logLevel), problems);
  const host = readHost(read(SETTINGS.host), problems);

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

  const timezone = readTimezone(read(SETTINGS.timezone), problems);
  const terminalCap = readTerminalCap(read(SETTINGS.terminalCap), problems);
  const drainMs = readDrainSeconds(read(SETTINGS.drainSeconds), problems);
  const announce = readAnnounce(read(SETTINGS.announce), problems);
  const identityPath = readIdentityPath(read(SETTINGS.serverIdentityFile), env, problems);
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
      browseRoots,
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
