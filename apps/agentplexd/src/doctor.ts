import type { ProviderReadiness } from '@agentplex/protocol';
import type { Config, Role } from './config/config.js';
import type { ProviderPreflight, ProviderRegistry, StoreFileSystem } from '@agentplex/providers';

/**
 * `agentplexd doctor`: what this configuration can start, and nothing changed.
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
 */

export interface DoctorDependencies {
  readonly providers: ProviderRegistry;
  readonly preflight: ProviderPreflight;
  readonly files: StoreFileSystem;
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
  { providers, preflight, files }: DoctorDependencies,
): Promise<DoctorReport> {
  // A hub-only process starts no sessions, mounts no stores and drives no
  // providers. Probing them anyway would report on a machine this configuration
  // never touches.
  if (!('server' in config)) {
    return { role: config.role, usable: true, providers: [], stores: [] };
  }

  const readiness = await preflight.run(providers);
  const stores = await Promise.all(config.server.storePaths.map((path) => checkStore(path, files)));

  return {
    role: config.role,
    usable:
      readiness.every((provider) => provider.state === 'ready') &&
      stores.every((store) => store.state === 'present'),
    providers: readiness,
    stores,
  };
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
  const lines = [`agentplexd doctor  role=${report.role}`, ''];

  lines.push('providers');
  if (report.providers.length === 0) {
    lines.push(
      report.role === 'hub'
        ? '  this process has no server role, so it starts no sessions'
        : '  this build drives no providers',
    );
  } else {
    for (const provider of report.providers) lines.push(`  ${providerLine(provider)}`);
  }

  lines.push('', 'stores');
  if (report.stores.length === 0) {
    lines.push(
      report.role === 'hub'
        ? '  this process has no server role, so it mounts no stores'
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

function storeLine(store: StoreCheck): string {
  const line = `${store.state.padEnd(10)} ${store.path}`;
  return store.problem === null ? line : `${line}\n    ${store.problem}`;
}
