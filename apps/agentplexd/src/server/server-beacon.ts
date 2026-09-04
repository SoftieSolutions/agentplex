import {
  BEACON_ANNOUNCE_INTERVAL_MS,
  PROTOCOL_VERSION,
  formatServerBeacon,
  type ServerId,
} from '@agentplex/protocol';
import type { Logger } from '../shared/logger.js';
import type { Timers } from '../shared/timers.js';

/**
 * Saying, on the local network, that this server exists.
 *
 * Opt-in, because the alternative is a program that starts broadcasting its
 * address on somebody's network because it was installed. On a laptop on a
 * cafe wifi that is a fact about the machine given to everyone in the room,
 * and no default can be right for both that and the homelab where discovery is
 * the whole convenience. So the operator says so, once, and the setting is off
 * until they do. Listening, on the hub side, has no such cost and is
 * unconditional.
 *
 * What it announces is four facts and no secret: who this server calls itself,
 * where it is, the port the hub dials, and the protocol it speaks. Pairing is
 * still the user typing this server's token into the hub — a beacon only saves
 * them from typing an address, which is the entire value on offer and exactly
 * as much trust as a datagram from an unauthenticated stranger can buy.
 *
 * The socket is a seam. `dgram` lives in `node-beacon-transport.ts` and
 * nowhere else, so these rules are testable without a machine that has a
 * network at all.
 */

/** Where a formatted beacon goes. One line of the datagram API, and no more of it. */
export interface BeaconTransport {
  /**
   * Sends one beacon. Throwing is expected and survivable: a broadcast can
   * fail because the network is not up yet, and the caller retries next tick.
   */
  send(payload: string): void;
  close(): void;
}

/**
 * What the process supplies to a server that announces.
 *
 * The two things a beacon needs from the machine and cannot work out for
 * itself: a socket to broadcast on, and the addresses this host actually has.
 */
export interface BeaconNetwork {
  open(): BeaconTransport;
  /** Dialable addresses of this host, best first. Loopback and link-local are not among them. */
  localAddresses(): readonly string[];
}

export interface ServerBeaconDependencies {
  readonly transport: BeaconTransport;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly serverId: ServerId;
  /** The address to announce, already chosen by `chooseBeaconAddress`. */
  readonly address: string;
  /** The port the hub dials — this server's own, never the beacon port. */
  readonly port: number;
  readonly intervalMs?: number;
}

export interface ServerBeaconAnnouncer {
  /** Stops announcing and closes the socket. Safe to call more than once. */
  stop(): void;
}

/**
 * Starts announcing, immediately and then on the shared interval.
 *
 * Immediately because the moment a server starts is the moment somebody is
 * most likely to be looking for it, and waiting out an interval first would
 * make a fresh server appear to be missing for exactly as long as the design
 * spends deciding an absent one is gone.
 *
 * The payload is built once. It cannot change while the process runs — the
 * identity is minted before anything is served and the port is bound — so
 * rebuilding it per tick would only create the possibility of it differing
 * between two announcements of the same server.
 */
export function startServerBeacon(dependencies: ServerBeaconDependencies): ServerBeaconAnnouncer {
  const { transport, timers, logger, serverId, address, port } = dependencies;
  const intervalMs = dependencies.intervalMs ?? BEACON_ANNOUNCE_INTERVAL_MS;

  const payload = formatServerBeacon({
    type: 'agentplex-server-beacon',
    protocolVersion: PROTOCOL_VERSION,
    serverId,
    address,
    port,
  });

  let stopped = false;
  let cancel: (() => void) | null = null;

  const announce = (): void => {
    try {
      transport.send(payload);
    } catch (error) {
      // One datagram, one line, and the schedule is untouched. A server that
      // came up before its network did must announce again when the network
      // arrives, and tearing the beacon down over a failed send is how that
      // machine stays invisible until somebody restarts it.
      logger.warn('beacon not sent', { error: String(error) });
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    cancel = timers.schedule(intervalMs, () => {
      if (stopped) return;
      announce();
      scheduleNext();
    });
  };

  announce();
  scheduleNext();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancel?.();
      cancel = null;
      transport.close();
    },
  };
}

export interface AnnounceOptions {
  /** The interface this server was told to bind, which may be a wildcard. */
  readonly host: string;
  /** The port the hub dials, taken from the listener rather than the setting. */
  readonly port: number;
  readonly serverId: ServerId;
  readonly timers: Timers;
  readonly logger: Logger;
}

/**
 * Starts announcing, or does not.
 *
 * The opt-in is the `null`: a server that was not asked to announce has no
 * network to announce on, so there is no state in which the setting is off and
 * a socket is open anyway. Where a boolean would leave that combination
 * expressible, this leaves it unrepresentable.
 *
 * It also declines to announce when nothing dialable is known, which is the
 * same refusal to over-claim: a beacon is only useful if acting on it works.
 */
export function announceServer(
  network: BeaconNetwork | null,
  { host, port, serverId, timers, logger }: AnnounceOptions,
): ServerBeaconAnnouncer | null {
  if (network === null) return null;

  const address = chooseBeaconAddress(host, network.localAddresses());
  if (address === null) {
    logger.warn('not announcing: no address on this machine that a hub could dial', { host });
    return null;
  }

  logger.info('announcing on the local network', {
    address,
    port,
    intervalMs: BEACON_ANNOUNCE_INTERVAL_MS,
  });
  return startServerBeacon({
    transport: network.open(),
    timers,
    logger,
    serverId,
    address,
    port,
  });
}

/**
 * The interfaces a bound wildcard does not name. Announcing one of these would
 * put a machine in the pairing form at an address that cannot be dialled.
 */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '::0', '0']);

/**
 * Which address to announce, or `null` for a server that should stay quiet.
 *
 * A configured host wins, because it is the operator saying where this machine
 * is reachable, and they know about the NAT and the VPN that this process does
 * not. The default host is `0.0.0.0`, which is what was bound rather than
 * anywhere to dial, so the machine's own addresses answer instead.
 *
 * `null` rather than a guess is the point: a beacon that names a wildcard is a
 * claim that fails at the moment the user acts on it, and the failure lands on
 * them. Announcing nothing leaves the address field of the pairing form empty,
 * which is where it started.
 */
export function chooseBeaconAddress(host: string, addresses: readonly string[]): string | null {
  if (!WILDCARD_HOSTS.has(host)) return host;
  return addresses[0] ?? null;
}
