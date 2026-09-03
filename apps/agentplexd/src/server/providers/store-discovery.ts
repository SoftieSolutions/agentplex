import type { Provider, SessionDescriptor, SessionRef, StoreDescriptor } from '@agentplex/protocol';
import type { Clock } from '../../shared/clock.js';
import type { DiscoveryProblem, ProviderAdapter } from './provider-adapter.js';
import type { ProviderRegistry } from './provider-registry.js';

/**
 * Every session in one store, whichever provider left it there.
 *
 * A store is not a provider's directory: several providers may have written
 * into the same volume, and a user thinks in stores. So the composition of
 * "ask each registered adapter" lives here, above the adapters and below
 * anything that talks to the hub, and it is the only place that stamps a
 * `storeId` onto what an adapter found.
 */

/** Which sessions have a live process on this server. */
export interface SessionLiveness {
  /**
   * Pid liveness and the spawn epoch are already checked by whoever implements
   * this: the process registry's entries go stale, and a pid that has been
   * reused is a different program.
   */
  isRunning(session: SessionRef): boolean;
}

/** Before the PTY supervisor exists, nothing is running, and saying so is honest. */
export const noLiveSessions: SessionLiveness = { isRunning: () => false };

export interface StoreDiscoveryDependencies {
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly liveness: SessionLiveness;
}

export interface StoreDiscoveryProblem extends DiscoveryProblem {
  /** Stamped here, from the adapter that was asked: an adapter cannot misattribute itself. */
  readonly provider: Provider;
}

export interface StoreSessions {
  readonly sessions: readonly SessionDescriptor[];
  readonly problems: readonly StoreDiscoveryProblem[];
}

/**
 * Asks every registered adapter what it has in this store.
 *
 * Concurrent, because providers are independent, and total, because a store
 * that has one broken provider still has its other sessions. An adapter that
 * throws is treated exactly like a file it could not read: once this is open
 * source an adapter is somebody else's code, and a store listing that a third
 * party can take down by throwing is a listing nobody can trust.
 */
export async function discoverStoreSessions(
  store: StoreDescriptor,
  { registry, clock, liveness }: StoreDiscoveryDependencies,
): Promise<StoreSessions> {
  const now = clock.now();
  const found = await Promise.all(
    registry.adapters.map((adapter) => discoverWithAdapter(store, adapter, liveness, now)),
  );

  return {
    sessions: found.flatMap((one) => one.sessions),
    problems: found.flatMap((one) => one.problems),
  };
}

async function discoverWithAdapter(
  store: StoreDescriptor,
  adapter: ProviderAdapter,
  liveness: SessionLiveness,
  now: number,
): Promise<StoreSessions> {
  const { provider } = adapter;

  let discovered;
  try {
    discovered = await adapter.discover(store);
  } catch (error) {
    return {
      sessions: [],
      problems: [{ provider, subject: store.path, problem: `adapter failed: ${String(error)}` }],
    };
  }

  const sessions = discovered.sessions.map((session): SessionDescriptor => {
    const ref: SessionRef = { storeId: store.storeId, sessionId: session.sessionId };
    return {
      ...ref,
      provider,
      status: adapter.status({
        signal: session.signal,
        updatedAt: session.updatedAt,
        running: liveness.isRunning(ref),
        now,
      }),
      updatedAt: session.updatedAt,
      // Carried, not re-derived. Only the adapter can read these out of a
      // provider's own format, and anything above it that tried to guess a cwd
      // from a directory name would be guessing at a lossy encoding.
      cwd: session.cwd,
      title: session.title,
    };
  });

  return {
    sessions,
    problems: discovered.problems.map((problem) => ({ provider, ...problem })),
  };
}
