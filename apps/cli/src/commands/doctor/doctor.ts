import { dirname } from 'node:path';
import type { ProviderReadiness } from '@agentplex/protocol';
import { NODE_PTY_REMEDY, type PtyAvailability } from '@agentplex/pty';
import type { Config, Role, SettingsSource } from './config.js';
import {
  hubLines,
  hubUsable,
  inspectHub,
  type HubChecks,
  type HubDependencies,
  type PathAccess,
} from './hub.js';
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
 * Read-only, and structurally so. Nothing here can mint a store file or a
 * server identity, because the filesystem calls it makes are `statDirectory`
 * and `readFile` -- `ensureStores` and `ensureServerIdentity`, which are what
 * mint, are not reachable from this file. A doctor that changed the machine it
 * was asked to describe would be worse than no doctor: it would make "run
 * doctor first" a thing you have to think about.
 *
 * The hub half has one bounded exception, in `hub.ts` and stated there: asking
 * whether the hub's port is already held means binding it and letting go, which
 * is the only portable way to get an answer. It leaves nothing behind.
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

export interface DoctorDependencies extends HubDependencies {
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
   * The settings file this report describes, or why it could not be read.
   * Never part of `usable`: a file this user may not read is a machine this
   * user can still inspect by environment and flags, and the line says so.
   */
  readonly settings: SettingsSource;
  /**
   * Whether everything this looked at can actually be used.
   *
   * On the report rather than left to whoever prints it, because it is also the
   * process's exit code, and a shell script asking "is this box ready" should
   * not have to grep prose to find out.
   */
  readonly usable: boolean;
  /** What the hub needs at boot, or `null` on a role that runs none. */
  readonly hub: HubChecks | null;
  /** One per registered provider, exactly as the preflight found it. */
  readonly providers: readonly ProviderReadiness[];
  /** One per configured store path, in the order they were configured. */
  readonly stores: readonly StoreCheck[];
  /**
   * One per configured browse root, in the order they were configured.
   *
   * The same check a store gets, against the same seam, and for the same
   * reason: "is that directory actually there" is the question an operator who
   * has just typed a path wants answered before a client tells them it is not.
   * An empty list is a machine that browses nothing, which is the default and
   * is reported as a sentence rather than as a problem.
   */
  readonly browseRoots: readonly StoreCheck[];
  /** The pty seam, or `null` on a role that opens none. */
  readonly terminals: TerminalCheck | null;
  /** The directory the server writes into, or `null` on a role that runs none. */
  readonly dataRoot: DataRootCheck | null;
}

/**
 * The server's data root, as the server will meet it at boot.
 *
 * The server creates it with every parent and refuses to start when it cannot
 * create it or cannot write in it (`data-root.ts` in the server carries that
 * rule). So there are three answers and not two: `ready` is a directory this
 * user may write in, `creatable` is one that is not there yet under a directory
 * this user may write in -- the ordinary first start -- and `unusable` is every
 * way the server would refuse. Only the last one is a machine that is not
 * ready.
 */
export interface DataRootCheck {
  readonly path: string;
  readonly state: 'ready' | 'creatable' | 'unusable';
  /** What to say beneath the line, or `null` when there is nothing to add. */
  readonly detail: string | null;
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
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const { providers, preflight, files, terminals } = dependencies;

  // A machine that runs no hub opens no database, holds no client token and
  // serves no client; a machine that runs no server starts no sessions, mounts
  // no stores and drives no providers. Probing either anyway would report on a
  // machine this deployment never touches.
  const hub = 'hub' in config ? await inspectHub(config.hub, config.host, dependencies) : null;

  if (!('server' in config)) {
    return {
      role: config.role,
      settings: config.settings,
      usable: hub === null || hubUsable(hub),
      hub,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
      dataRoot: null,
    };
  }

  const readiness = await preflight.run(providers);
  const stores = await Promise.all(config.server.storePaths.map((path) => checkStore(path, files)));
  const browseRoots = await Promise.all(
    config.server.browseRoots.map((path) => checkStore(path, files)),
  );
  const pty = checkTerminals(terminals());
  const dataRoot = await checkDataRoot(config.server.dataPath, files, dependencies.access);

  return {
    role: config.role,
    settings: config.settings,
    usable:
      (hub === null || hubUsable(hub)) &&
      readiness.every((provider) => provider.state === 'ready') &&
      stores.every((store) => store.state === 'present') &&
      // A configured root that is not there is a browse that will be refused,
      // which is a fact about this deployment and therefore part of the exit
      // code. Having none is not: that is the default, and a machine nobody
      // asked to offer browsing is working exactly as configured.
      browseRoots.every((root) => root.state === 'present') &&
      pty.state === 'ready' &&
      dataRoot.state !== 'unusable',
    hub,
    providers: readiness,
    stores,
    browseRoots,
    terminals: pty,
    dataRoot,
  };
}

/**
 * The data root, without creating it.
 *
 * Asked the way `checkDatabase` in `hub.ts` asks about the hub's database: of
 * the things already there, through `statDirectory` and then `access`, because
 * `access` on its own answers `denied` for a path that does not exist, which
 * would report the ordinary first start as a failure. Where the database
 * question stops at the directory above -- the hub creates the file and not
 * the directory -- this one keeps climbing to the nearest directory that is
 * there, because the server's create is recursive: `/srv/agentplex/data` under
 * a writable `/srv` is a data root it can make.
 */
async function checkDataRoot(
  path: string,
  files: StoreFileSystem,
  access: PathAccess,
): Promise<DataRootCheck> {
  const entry = await files.statDirectory(path);
  switch (entry.kind) {
    case 'directory': {
      const writable = await access(path);
      return writable.kind === 'writable'
        ? { path, state: 'ready', detail: null }
        : {
            path,
            state: 'unusable',
            detail: `the server could not write in it: ${writable.reason}`,
          };
    }
    case 'not-a-directory':
      return { path, state: 'unusable', detail: 'that path is not a directory' };
    case 'failed':
      return { path, state: 'unusable', detail: entry.reason };
    case 'missing':
      return await checkDataRootAncestor(path, files, access);
  }
}

/** The nearest directory above a missing data root, and whether it may be written in. */
async function checkDataRootAncestor(
  path: string,
  files: StoreFileSystem,
  access: PathAccess,
): Promise<DataRootCheck> {
  let ancestor = dirname(path);
  for (;;) {
    const entry = await files.statDirectory(ancestor);
    switch (entry.kind) {
      case 'directory': {
        const writable = await access(ancestor);
        return writable.kind === 'writable'
          ? {
              path,
              state: 'creatable',
              detail: `not there yet: it will be created at startup, under ${ancestor}`,
            }
          : {
              path,
              state: 'unusable',
              detail: `not there, and the server could not create it under ${ancestor}: ${writable.reason}`,
            };
      }
      case 'not-a-directory':
        return { path, state: 'unusable', detail: `${ancestor} is not a directory` };
      case 'failed':
        return { path, state: 'unusable', detail: entry.reason };
      case 'missing': {
        const parent = dirname(ancestor);
        // The root itself missing is a filesystem this process cannot see at
        // all, and there is nothing further up to ask.
        if (parent === ancestor) {
          return { path, state: 'unusable', detail: 'no directory above it is there' };
        }
        ancestor = parent;
      }
    }
  }
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

  // First of all, because it says what everything below is a report on: the
  // file the daemons' units name, or the environment and flags alone.
  lines.push('settings', ...settingsLines(report.settings), '');

  // First, because on the machine this section is about it is the whole report
  // and on a server it is one line. The other order makes a hub operator read
  // three "runs no server" lines before reaching anything about their machine.
  lines.push('hub');
  if (report.hub === null) {
    lines.push('  this machine runs no hub, so it opens no database and serves no client');
  } else {
    lines.push(...hubLines(report.hub));
  }

  // Before the providers, because it gates them: a provider that is installed
  // and logged in still starts nothing on a machine that cannot open a
  // pseudoterminal.
  lines.push('', 'terminals');
  if (report.terminals === null) {
    lines.push('  this machine runs no server, so it opens no terminals');
  } else {
    lines.push(...terminalLines(report.terminals));
  }

  // Beside the terminals, because it gates the server the same way: one that
  // cannot create or write its data root does not start.
  lines.push('', 'data root');
  if (report.dataRoot === null) {
    lines.push('  this machine runs no server, so it writes no data root');
  } else {
    lines.push(`  ${dataRootLine(report.dataRoot)}`);
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

  lines.push('', 'browse roots');
  if (report.browseRoots.length === 0) {
    lines.push(
      report.role === 'hub'
        ? '  this machine runs no server, so nothing browses it'
        : // Not a problem, and said so. This is the default and it is the
          // direction that does not over-claim: what a root grants is a listing
          // of this machine's files to anybody who can reach a paired hub.
          '  none configured, so this server will not list any directory',
    );
  } else {
    for (const root of report.browseRoots) lines.push(`  ${storeLine(root)}`);
    lines.push(
      '',
      '  Anything under these can be listed by a client of any hub this server',
      '  is paired with. Nothing else can: a path outside them is refused, and',
      '  a symlink is reported and never followed.',
    );
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

function dataRootLine(root: DataRootCheck): string {
  const line = `${root.state.padEnd(10)} ${root.path}`;
  return root.detail === null ? line : `${line}\n    ${root.detail}`;
}

/**
 * Where the report's settings came from. A file that could not be read is said
 * first and plainly, because everything below it was read without that file --
 * which on a fleet machine is most of what the daemons are started with.
 */
function settingsLines(settings: SettingsSource): readonly string[] {
  const instead = '    so this read the environment and flags only';
  if (settings.problems.length > 0) {
    return [...settings.problems.map((problem) => `  ${problem}`), instead];
  }
  if (settings.file === null) return ['  no settings file found', instead];
  return [`  ${settings.file}`];
}
