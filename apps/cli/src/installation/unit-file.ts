import { join } from 'node:path';
import { daemonEntrypoint, daemonPackage } from './components.js';
import {
  SYSTEM_ACCOUNT,
  binDirectory,
  packageDirectory,
  stateDirectory,
  type Layout,
} from './layout.js';

/**
 * A daemon's systemd unit, as text.
 *
 * This is the one renderer. `install.sh` renders no unit since it hands the
 * install over to `agentplex install`: the install writes through this,
 * `agentplex install --print-unit` prints through it, and `install.sh
 * --print-unit` asks that command -- so the text a machine ends up with cannot
 * depend on which program happened to write it.
 *
 * It was the script's `render_unit` first, and the machines installed before
 * the handover carry that text. `unit-file.test.ts` holds this output byte for
 * byte against units the script printed, captured under `fixtures/units/`, so
 * a unit this writes is the unit an older install wrote and an operator diffing
 * one against `--print-unit` sees no difference. A deliberate change to the
 * unit changes those fixtures with it, re-captured from `agentplex install
 * --print-unit`.
 */

/** The two daemons, which are the two components that get a unit. */
export type Daemon = 'hub' | 'server';

/** `install.sh`'s `DOCS_URL`, which every unit names as its documentation. */
export const DOCS_URL =
  'https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md';

/**
 * How long a stop may take, and how much of that the server may spend waiting.
 *
 * One decision written as two numbers, because systemd needs one of them and
 * the daemon needs the other, and the unit renders both from here so they
 * cannot drift. The server drains on SIGTERM: no new sessions, and the agents
 * already running are given until the drain budget to reach a turn boundary,
 * because killing one mid-tool is how a half-applied edit gets left on disk.
 * That is only a drain because the server unit says `KillMode=mixed`: systemd's
 * default signals every process in the unit's cgroup at once, and the agents are
 * in it, so they would get the same SIGTERM in the same millisecond the server
 * started waiting for them. With mixed the server alone gets it. systemd sends
 * SIGKILL after `TimeoutStopSec` whatever the daemon is doing, so a drain that
 * outlasted it would not be a drain -- it would be a hang followed by the same
 * kill. The margin is what the process has left after it stops waiting: kill
 * the stragglers, close the sockets, exit.
 *
 * The daemon's own default is the same fifteen seconds, for a checkout or an
 * image that has no unit to read this from.
 */
export const STOP_TIMEOUT_SECONDS = 20;
export const STOP_KILL_MARGIN_SECONDS = 5;

/** The directories a service already searches, which the unit's PATH ends with. */
const STANDARD_SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** `agentplex-hub.service`, `agentplex-server.service`: the same in both scopes. */
export function unitFileName(daemon: Daemon): string {
  return `agentplex-${daemon}.service`;
}

/**
 * One unit, for one daemon, in one layout.
 *
 * `nodeDirectory` is the directory whose `node` ExecStart names, decided by
 * `resolveNodeDirectory` exactly as `resolve_node_directory` decides it. It is
 * a parameter rather than something this looks up, so the text is a pure
 * function of what was resolved and a fixture can name the inputs it was
 * captured with.
 */
export function renderUnit(daemon: Daemon, layout: Layout, nodeDirectory: string): string {
  const system = layout.scope === 'system';
  return [
    '[Unit]',
    `Description=agentplex ${daemon}`,
    `Documentation=${DOCS_URL}`,
    ...(system ? ['After=network-online.target', 'Wants=network-online.target'] : []),
    '',
    '[Service]',
    'Type=simple',
    ...(system ? [`User=${SYSTEM_ACCOUNT}`, `Group=${SYSTEM_ACCOUNT}`] : []),
    `WorkingDirectory=${stateDirectory(layout)}`,
    `EnvironmentFile=${layout.settingsFile}`,
    '# The prefix goes first, and the directory holding the node this install',
    '# settled on comes with it when that is somewhere a service would never look --',
    `# ${layout.prefix}/node/bin, or a version manager's shims.`,
    '#',
    '# The reason is no longer ExecStart. That line names the interpreter and the',
    '# script outright, so it resolves nothing through this PATH and cannot be the',
    '# #!/usr/bin/env node failure it used to be. What is left is everything the',
    '# daemon starts afterwards, and it is reason enough on its own: a session is not',
    '# only the agent, it shells out to git, rg and whatever else the project needs,',
    "# and the coding agents agentplex setup installs into the prefix's bin are",
    '# themselves scripts whose first line is #!/usr/bin/env node, which finds',
    "# nothing unless the runtime's own directory is named here. In front of the rest",
    '# of the machine rather than instead of it.',
    `Environment=PATH=${unitSearchPath(layout, nodeDirectory)}`,
    `ExecStart=${daemonCommand(daemon, layout, nodeDirectory)}`,
    // The server only: SIGHUP re-reads its providers. The hub has nothing to
    // re-read, and a SIGHUP to a Node process with no listener is an exit, so a
    // reload offered on the hub would be a verb that restarts it.
    ...(daemon === 'server' ? ["ExecReload=/bin/sh -c 'kill -HUP $MAINPID'"] : []),
    'Restart=on-failure',
    'RestartSec=5s',
    '# Exit 2 is the daemon saying the configuration is wrong. Restarting will not',
    '# help and the operator has to act, so the unit stops instead of hiding the',
    '# message in a restart loop.',
    'RestartPreventExitStatus=2',
    '# SIGTERM is the default and the signal main.ts shuts down on. The server drains',
    '# first -- it waits for the turns it is holding to reach a boundary -- and that',
    '# wait is only worth anything because systemd signals the server alone: the',
    "# server's unit carries KillMode=mixed, so the agents it is waiting for are not",
    '# sent the same SIGTERM in the same millisecond, and whatever is left in the',
    '# cgroup is SIGKILLed once the server exits. The drain and TimeoutStopSec lines',
    '# are the one number that bounds both halves of the drain: the daemon stops',
    "# waiting with the margin still to go, and systemd's SIGKILL is what it is",
    '# racing. A second SIGTERM means the operator is done waiting and skips to the',
    '# kill -- sent with `systemctl kill --kill-whom=main`, because a bare',
    '# `systemctl kill` signals every process in the unit whatever KillMode says.',
    '# The hub ignores the drain setting; both daemons share this unit template.',
    // The server only. systemd's default, control-group, sends the stop's
    // SIGTERM to every process in the unit's cgroup, and a session's agent is in
    // it: mixed signals the main process alone and SIGKILLs what is left once it
    // exits. The hub runs no children to spare and keeps the default.
    ...(daemon === 'server' ? ['KillMode=mixed'] : []),
    `Environment=AGENTPLEX_SERVER_DRAIN_SECONDS=${String(STOP_TIMEOUT_SECONDS - STOP_KILL_MARGIN_SECONDS)}`,
    `TimeoutStopSec=${String(STOP_TIMEOUT_SECONDS)}s`,
    '',
    '# There is deliberately no sandboxing here -- no ProtectHome, no',
    "# ProtectSystem=strict, no NoNewPrivileges. This service's job is to run a",
    "# developer's own tooling as that developer, against their home directory and",
    '# their checkouts, and every one of those directives turns that job into a',
    '# failure that reads like a bug in the agent. The isolation that matters is the',
    '# account this runs as, and that is settled by where this unit lives: a user',
    '# unit runs as its user, and the system unit carries User=.',
    '',
    '[Install]',
    `WantedBy=${system ? 'multi-user.target' : 'default.target'}`,
    '',
  ].join('\n');
}

/**
 * The unit's PATH: the prefix's bin, then the node directory when it is
 * neither that nor somewhere a service already searches, then the machine's
 * own directories. `unit_search_path`, for the processes the daemon starts --
 * the coding agents in the prefix's bin are scripts looking for `node`.
 */
export function unitSearchPath(layout: Layout, nodeDirectory: string): string {
  const bin = binDirectory(layout);
  const named =
    nodeDirectory !== bin && !STANDARD_SEARCH_PATH.split(':').includes(nodeDirectory)
      ? `${bin}:${nodeDirectory}`
      : bin;
  return `${named}:${STANDARD_SEARCH_PATH}`;
}

/**
 * How a daemon is started: the interpreter by its full path, and the daemon's
 * compiled entry inside the package npm wrote. No search decides either half.
 */
function daemonCommand(daemon: Daemon, layout: Layout, nodeDirectory: string): string {
  const name = daemonPackage(daemon);
  if (name === null) {
    // Unreachable for the two daemons the type admits, and a throw rather than a
    // `!` because it is `daemonPackage`'s table that makes it so.
    throw new Error(`no package holds a ${daemon} daemon`);
  }
  return `${join(nodeDirectory, 'node')} ${join(packageDirectory(layout, name), daemonEntrypoint(daemon))}`;
}
