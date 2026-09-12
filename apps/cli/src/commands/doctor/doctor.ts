import type { ProviderReadiness } from '@agentplex/protocol';
import { NODE_PTY_REMEDY, type PtyAvailability } from '@agentplex/pty';
import type { Config, Role } from './config.js';
import type { ProviderPreflight, ProviderRegistry, StoreFileSystem } from '@agentplex/providers';

/**
 * `agentplex doctor`: what this configuration can start, and nothing changed.
 *
 * It runs the same preflight the server role runs at boot, against the same
 * search path, through the same seams. That is the design and not an
 * implementation convenience: a doctor with its own idea of where `claude` is
 * would eventually disagree with the service, and the one situation where that
 * happens is the one where somebody is already staring at a machine trying to
 * work out why a session will not start.
 *
 * Read-only, and structurally so. Nothing here can mint a store file, because
 * the only filesystem call it makes is `statDirectory` -- `ensureStores`, which
 * is what mints, is not reachable from this file. A doctor that changed the
 * machine it was asked to describe would be worse than no doctor: it would make
 * "run doctor first" a thing you have to think about.
 *
 * It asks whether node-pty loads, which is not the same as opening one: the
 * addon is a file the process maps, and mapping it changes nothing. The
 * question has to be here because node-pty is an optional dependency of the
 * published package -- a hub that never opens a pseudoterminal should not need
 * a C++ toolchain to install a program it does not run -- and npm exits 0 when
 * an optional dependency's build is skipped or fails. Without this, the machine
 * where that happened looks healthy right up to the first session that will not
 * start.
 */

export interface DoctorDependencies {
  readonly providers: ProviderRegistry;
  readonly preflight: ProviderPreflight;
  readonly files: StoreFileSystem;
  /**
   * Whether a pseudoterminal can be opened here, asked exactly the way the
   * server asks it at startup. Injected rather than called directly for the
   * reason the preflight is: an addon that will not load is not a thing a test
   * can arrange, and two implementations of this question would eventually
   * disagree in front of somebody trying to work out why a session hangs.
   */
  readonly terminals: () => PtyAvailability;
}

export interface DoctorReport {
  readonly role: Role;
  /**
   * Whether everything this looked at can actually be used.
   *
   * On the report rather than left to whoever prints it, because it is also the
   * process's exit code, and a shell script asking "is this box ready" should
   * not have to grep prose to find out.
   */
  readonly usable: boolean;
  /** One per registered provider, exactly as the preflight found it. */
  readonly providers: readonly ProviderReadiness[];
  /** One per configured store path, in the order they were configured. */
  readonly stores: readonly StoreCheck[];
  /** The pty seam, or `null` on a role that opens none. */
  readonly terminals: TerminalCheck | null;
}

/**
 * Whether this installation can drive a session at all.
 *
 * `unusable` carries the load failure verbatim: the two shapes it takes -- npm
 * removed the package after its build failed, or an `ignore-scripts` install
 * left the sources with no addon beside them -- are different things to fix,
 * and a doctor that flattened them into "broken" would have thrown away the
 * only sentence that says which.
 */
export interface TerminalCheck {
  readonly state: 'ready' | 'unusable';
  /** What is wrong, in words, or `null` when nothing is. */
  readonly problem: string | null;
}

export interface StoreCheck {
  readonly path: string;
  readonly state: StoreState;
  /** What is wrong, in words, or `null` when nothing is. */
  readonly problem: string | null;
}

/**
 * A store root as it is right now.
 *
 * `present` says the directory is there and says nothing about what is in it: a
 * store with no sessions yet is a perfectly good store, and a doctor that
 * called it empty would be inventing a problem. `unusable` covers the two ways
 * something is there and will not serve -- the wrong kind of thing, or one this
 * process may not read.
 */
export type StoreState = 'present' | 'missing' | 'unusable';

export async function inspectMachine(
  config: Config,
  { providers, preflight, files, terminals }: DoctorDependencies,
): Promise<DoctorReport> {
  // A hub-only machine starts no sessions, mounts no stores and drives no
  // providers. Probing them anyway would report on a machine this deployment
  // never touches.
  if (!('server' in config)) {
    return { role: config.role, usable: true, providers: [], stores: [], terminals: null };
  }

  const readiness = await preflight.run(providers);
  const stores = await Promise.all(config.server.storePaths.map((path) => checkStore(path, files)));
  const pty = checkTerminals(terminals());

  return {
    role: config.role,
    usable:
      readiness.every((provider) => provider.state === 'ready') &&
      stores.every((store) => store.state === 'present') &&
      pty.state === 'ready',
    providers: readiness,
    stores,
    terminals: pty,
  };
}

function checkTerminals(availability: PtyAvailability): TerminalCheck {
  return availability.usable
    ? { state: 'ready', problem: null }
    : { state: 'unusable', problem: availability.problem };
}

async function checkStore(path: string, files: StoreFileSystem): Promise<StoreCheck> {
  const state = await files.statDirectory(path);
  switch (state.kind) {
    case 'directory':
      return { path, state: 'present', problem: null };
    case 'missing':
      return { path, state: 'missing', problem: 'there is nothing at that path' };
    case 'not-a-directory':
      return { path, state: 'unusable', problem: 'that path is not a directory' };
    case 'failed':
      return { path, state: 'unusable', problem: state.reason };
  }
}

/**
 * The report as lines to print.
 *
 * Pure, and separate from the gathering, so that what an operator reads is a
 * value a test can assert on rather than something only a terminal has ever
 * seen. Columns are padded rather than tabulated: a fixed width survives being
 * pasted into an issue, and nothing here is wide enough to need more.
 */
export function formatDoctorReport(report: DoctorReport): readonly string[] {
  const lines = [`agentplex doctor  role=${report.role}`, ''];

  // First, because it gates the rest: a provider that is installed and logged
  // in still starts nothing on a machine that cannot open a pseudoterminal.
  lines.push('terminals');
  if (report.terminals === null) {
    lines.push('  this machine runs no server, so it opens no terminals');
  } else {
    lines.push(...terminalLines(report.terminals));
  }

  lines.push('', 'providers');
  if (report.providers.length === 0) {
    lines.push(
      report.role === 'hub'
        ? '  this machine runs no server, so it starts no sessions'
        : '  this build drives no providers',
    );
  } else {
    for (const provider of report.providers) lines.push(`  ${providerLine(provider)}`);
    // The one thing a read-only report can do about a reading somebody else is
    // still publishing. This probed the machine just now; a running server
    // probed it at its own boot and carries that answer into every handshake,
    // so on a box that has just been fixed the two disagree -- and the operator
    // staring at a `ready` here and a `missing` in the client needs to know
    // that ending the disagreement does not mean restarting the service and
    // dropping every session on the machine with it.
    lines.push(
      '',
      '  A running server read this at its own boot and reports that reading to',
      '  every hub. If what is above is not what the hub shows, reload the unit',
      '  rather than restarting it: systemctl reload agentplex-server.',
    );
  }

  lines.push('', 'stores');
  if (report.stores.length === 0) {
    lines.push(
      report.role === 'hub'
        ? '  this machine runs no server, so it mounts no stores'
        : '  no store paths are configured',
    );
  } else {
    for (const store of report.stores) lines.push(`  ${storeLine(store)}`);
  }

  return lines;
}

/**
 * One provider, with the directory it came from.
 *
 * The directory is the point of the line. "Which directory did this actually
 * come from" is the question an operator asks when the wrong version runs, and
 * before this there was nothing on the machine that could answer it.
 */
function providerLine(provider: ProviderReadiness): string {
  const columns = [
    provider.provider.padEnd(10),
    provider.state.padEnd(16),
    (provider.version ?? '-').padEnd(12),
    provider.directory ?? '-',
  ];
  const line = columns.join(' ').trimEnd();
  return provider.problem === null ? line : `${line}\n    ${provider.problem}`;
}

/**
 * The pty seam, with what to do about it when there is something to do.
 *
 * The remedy comes from the package that declares node-pty rather than being
 * written again here, so the operator who meets this in `doctor` and then in
 * the server's refusal to start is reading the same advice both times.
 */
function terminalLines(terminals: TerminalCheck): readonly string[] {
  if (terminals.problem === null) return [`  ${terminals.state}`];
  return [`  ${terminals.state}`, `    ${terminals.problem}`, `    ${NODE_PTY_REMEDY}`];
}

function storeLine(store: StoreCheck): string {
  const line = `${store.state.padEnd(10)} ${store.path}`;
  return store.problem === null ? line : `${line}\n    ${store.problem}`;
}
