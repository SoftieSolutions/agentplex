import type { ModuleResolver, PathAccess, PortProbe } from './hub.js';

/**
 * The machine the hub checks ask about, written down.
 *
 * A permission, a bound port and a package that is or is not installed are the
 * three things a suite cannot arrange honestly: it runs as whoever CI runs as,
 * on a host whose ports belong to somebody else, out of a tree where the client
 * package is linked into the hub's `node_modules` and not this app's. So each
 * is a value a test states, and the rules under test are a pure function of
 * them.
 *
 * Beside the seam rather than in `@agentplex/providers/testing`, because these
 * seams are the doctor's own: nothing outside this directory implements one.
 */

export interface FakePathAccessOptions {
  /** Paths this process may write at. Everything else is denied. */
  readonly writable?: readonly string[];
}

export function createFakePathAccess(options: FakePathAccessOptions = {}): PathAccess {
  const writable = new Set(options.writable ?? []);
  return async (path: string) =>
    writable.has(path) ? { kind: 'writable' } : { kind: 'denied', reason: `EACCES: ${path}` };
}

export interface FakePortProbeOptions {
  /** Addresses something already listens on, as `host:port`. */
  readonly taken?: readonly string[];
  /** Addresses the probe cannot bind for another reason, as `host:port` -> why. */
  readonly refused?: Readonly<Record<string, string>>;
}

export function createFakePortProbe(options: FakePortProbeOptions = {}): PortProbe {
  const taken = new Set(options.taken ?? []);
  const refused = new Map(Object.entries(options.refused ?? {}));
  return async (host: string, port: number) => {
    const address = `${host}:${String(port)}`;
    const reason = refused.get(address);
    if (reason !== undefined) return { kind: 'failed', reason };
    return taken.has(address) ? { kind: 'in-use' } : { kind: 'free' };
  };
}

/**
 * A resolver that answers for the specifiers a test says are installed, and
 * throws the way Node's does for the rest -- which is the whole of what the
 * client check reads: a sentence it puts in the report.
 */
export function createFakeModuleResolver(
  installed: Readonly<Record<string, string>>,
): ModuleResolver {
  return (specifier: string) => {
    const target = installed[specifier];
    if (target === undefined) {
      throw new Error(`Cannot find package '${specifier}'\nimported from a test`);
    }
    return target;
  };
}
