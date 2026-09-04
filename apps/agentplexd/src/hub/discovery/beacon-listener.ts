import {
  BEACON_EXPIRY_MS,
  BEACON_MISSED_LIMIT,
  checkProtocolVersion,
  parseServerBeacon,
  parseTextFrame,
  type ServerId,
} from '@agentplex/protocol';
import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';
import type { Timers } from '../../shared/timers.js';

/**
 * Hearing servers say where they are, and concluding almost nothing from it.
 *
 * Listening is unconditional, where announcing is opt-in, and the asymmetry is
 * the design rather than an oversight. Announcing puts a machine's address in
 * front of everyone on the network, which on a cafe wifi is a fact nobody asked
 * to publish; hearing one costs nothing and grants nothing. So a hub listens
 * whenever it runs, and what it does with everything it hears is offer to fill
 * in one line of the pairing form.
 *
 * What a candidate is not is the whole of this file's discipline. It is not a
 * peer: it lives in its own map, leaves in its own field of the frame, and has
 * its own type with no `registrationId` and no token anywhere near it. It is
 * not durable: nothing here touches the database, because a row in a table
 * outlives the process that wrote it and a beacon claim is a statement about
 * *now* -- a candidate read back after a restart would be a machine offered on
 * the strength of a datagram nobody heard. And it is not trusted: every field
 * is a claim by whoever sent the packet, and the distance between being heard
 * and being paired is the user typing that server's token.
 *
 * The socket is a seam. `dgram` lives in `node-beacon-listener.ts` and nowhere
 * else, so every rule below is testable on a machine with no network at all.
 */

/** One datagram, as the app reads it: bytes already decoded, and where from. */
export interface BeaconDatagram {
  /**
   * The datagram's payload as text.
   *
   * Decoded by whoever read it off the socket, because the protocol package
   * that parses it is bundled into a browser and has no `Buffer` to decode
   * with. Text in, parse result out, exactly as the announcing side hands text
   * out and lets its transport encode.
   */
  readonly text: string;
  /**
   * The address the datagram actually arrived from.
   *
   * A cross-check rather than a rule. A server told to announce a hostname is
   * announcing what its operator meant, so a disagreement with the announced
   * address is ordinary and refusing on it would silence the deployments that
   * configured themselves most deliberately. It is kept so an operator
   * debugging an address nothing can dial can see where the claim came from,
   * and it is not published: a client offered two addresses has been handed a
   * decision the hub could not make either.
   */
  readonly from: string;
}

/** A listening socket, from the one angle this file uses it. */
export interface BeaconReceiver {
  close(): void;
}

/** Where beacons come from. One line of the datagram API, and no more of it. */
export interface BeaconSource {
  /**
   * Starts listening, and calls back for every datagram until closed.
   *
   * A source that cannot bind is not an error here: the hub's actual job is
   * serving clients, and a discovery port already taken by something else must
   * not stop it. What that costs is candidates, which is what the pairing form
   * looked like before this existed.
   */
  listen(onDatagram: (datagram: BeaconDatagram) => void): BeaconReceiver;
}

/**
 * A machine the hub has heard from, as the hub holds it.
 *
 * `heardAt` and `heardFrom` are here and not on the wire. The first is the
 * aging, which is the hub's to do -- a client re-deriving "is this still
 * current" from a timestamp would be a second answer, and it would also mean
 * publishing a field that changes every five seconds per machine, waking every
 * attached client to tell them nothing changed. The second is the cross-check
 * above.
 */
export interface DiscoveredServer {
  readonly serverId: ServerId;
  readonly address: string;
  readonly port: number;
  /** What the beacon claimed. Judged by whoever decides what to draw. */
  readonly protocolVersion: number;
  readonly heardAt: number;
  readonly heardFrom: string;
}

export interface BeaconListenerDependencies {
  readonly source: BeaconSource;
  /**
   * What "how long since this machine spoke" is measured against. Injected for
   * the reason every clock here is: a test that waited out thirty real seconds
   * to watch a candidate age out is a test nobody runs.
   */
  readonly clock: Clock;
  /**
   * The deadline the sweep runs on.
   *
   * There is a sweep at all -- rather than only filtering on read -- because
   * expiry has to reach the client. A hub that dropped a candidate silently
   * would leave the machine on screen until something unrelated changed, which
   * is the stale offer the aging window exists to prevent.
   */
  readonly timers: Timers;
  readonly logger: Logger;
  /** Defaults to the shared window: six missed announcements. */
  readonly expiryMs?: number;
  /** Defaults to `MAX_CANDIDATES`. */
  readonly maxCandidates?: number;
}

/**
 * How many machines the hub will hold claims about at once.
 *
 * This is the one place an unauthenticated stranger can make a hub allocate,
 * and a map keyed by a field the sender chooses grows as fast as they can send.
 * The bound is far above any real network -- nobody is pairing with two hundred
 * and fifty six machines off one broadcast domain -- so in every honest
 * deployment it is unreachable.
 *
 * Full means the newcomer is refused, not that an existing claim is evicted.
 * Evicting would let a flood push the machine the user is actually looking for
 * out of the list, which is the failure worth avoiding; refusing costs only the
 * flood, and every held claim still ages out on its own.
 */
const MAX_CANDIDATES = 256;

export interface BeaconListener {
  /**
   * Every machine heard recently enough to still be offered, sorted by server
   * id. Never a claim that has aged out, whether or not the sweep has run yet.
   */
  readonly candidates: readonly DiscoveredServer[];
  /**
   * Called when the published set changes -- a machine arrived, moved, or aged
   * out. Not called for a repeat that says exactly what the last one did.
   */
  subscribe(listener: (candidates: readonly DiscoveredServer[]) => void): () => void;
  /** Closes the socket and forgets everything heard. Safe to call more than once. */
  stop(): void;
}

export function startBeaconListener(dependencies: BeaconListenerDependencies): BeaconListener {
  const { source, clock, timers } = dependencies;
  const logger = dependencies.logger.child({ part: 'discovery' });
  const expiryMs = dependencies.expiryMs ?? BEACON_EXPIRY_MS;
  const maxCandidates = dependencies.maxCandidates ?? MAX_CANDIDATES;

  const heard = new Map<ServerId, DiscoveredServer>();
  const listeners = new Set<(candidates: readonly DiscoveredServer[]) => void>();

  let stopped = false;
  let cancelSweep: (() => void) | null = null;

  const fresh = (candidate: DiscoveredServer, now: number): boolean =>
    now - candidate.heardAt < expiryMs;

  const current = (): readonly DiscoveredServer[] => {
    const now = clock.now();
    return [...heard.values()]
      .filter((candidate) => fresh(candidate, now))
      .sort((left, right) => (left.serverId < right.serverId ? -1 : 1));
  };

  /**
   * Tells every subscriber, and a listener that throws costs itself.
   *
   * The same rule the reducer applies to its own listeners, for the same
   * reason: one broken subscriber must not stop the others being told, and
   * must not leave discovery half-updated.
   */
  const publish = (): void => {
    const candidates = current();
    for (const listener of listeners) {
      try {
        listener(candidates);
      } catch (error) {
        logger.warn('a candidate listener threw', { problem: String(error) });
      }
    }
  };

  const sweep = (): void => {
    cancelSweep = null;
    if (stopped) return;

    const now = clock.now();
    let dropped = false;
    for (const [serverId, candidate] of [...heard]) {
      if (fresh(candidate, now)) continue;
      heard.delete(serverId);
      dropped = true;
      logger.info('a machine stopped announcing; no longer offering it', {
        serverId,
        missed: BEACON_MISSED_LIMIT,
      });
    }

    if (dropped) publish();
    scheduleSweep();
  };

  /**
   * One timer, aimed at the next claim due to expire.
   *
   * Rather than one per candidate, which would be a handle per machine on the
   * network to keep in step with every refresh. The earliest deadline is the
   * only one that can fire next, and every path that changes what is held
   * reschedules from what is held now.
   */
  function scheduleSweep(): void {
    cancelSweep?.();
    cancelSweep = null;
    if (stopped || heard.size === 0) return;

    const due = Math.min(...[...heard.values()].map((candidate) => candidate.heardAt + expiryMs));
    cancelSweep = timers.schedule(Math.max(0, due - clock.now()), sweep);
  }

  const accept = (datagram: BeaconDatagram): void => {
    if (stopped) return;

    const parsed = parseTextFrame(parseServerBeacon, datagram.text);
    if (!parsed.ok) {
      // An open UDP port collects whatever the network sends it. Another
      // program's datagram is not this one's fault, and a warning per packet
      // would make a busy network read as a hub in trouble.
      logger.debug('a datagram on the beacon port was not a beacon', {
        from: datagram.from,
        problem: parsed.reason,
      });
      return;
    }
    const beacon = parsed.value;

    const now = clock.now();
    const previous = heard.get(beacon.serverId);
    if (previous === undefined && heard.size >= maxCandidates) {
      // The machines already heard keep their places. A flood must not be able
      // to push out the one the user came to this screen to pair with.
      logger.warn('heard more machines than this hub will hold; ignoring one', {
        serverId: beacon.serverId,
        from: datagram.from,
        holding: heard.size,
      });
      return;
    }
    const visible = previous !== undefined && fresh(previous, now);
    const changed =
      !visible ||
      previous.address !== beacon.address ||
      previous.port !== beacon.port ||
      previous.protocolVersion !== beacon.protocolVersion;

    heard.set(beacon.serverId, {
      serverId: beacon.serverId,
      address: beacon.address,
      port: beacon.port,
      protocolVersion: beacon.protocolVersion,
      heardAt: now,
      heardFrom: datagram.from,
    });
    scheduleSweep();

    if (!changed) {
      // A repeat of what is already published. The claim's age was refreshed
      // above, which is the whole of what a repeat means; publishing here
      // would turn one machine announcing itself into a broadcast to every
      // attached client every five seconds, saying the same thing each time.
      return;
    }

    const mismatch = checkProtocolVersion(beacon.protocolVersion);
    if (mismatch === null) {
      logger.info('heard a server on the network', {
        serverId: beacon.serverId,
        address: beacon.address,
        port: beacon.port,
      });
    } else {
      // Kept and reported rather than dropped. A hub that ignored it could
      // only show silence, when what it can show is a machine it can see and
      // cannot speak to -- which is the difference between "nothing is there"
      // and "upgrade one of these two".
      logger.info('heard a server speaking another protocol', {
        serverId: beacon.serverId,
        address: beacon.address,
        expected: mismatch.expected,
        received: mismatch.received,
      });
    }

    publish();
  };

  const receiver = source.listen(accept);

  return {
    get candidates(): readonly DiscoveredServer[] {
      return current();
    },

    subscribe(listener: (candidates: readonly DiscoveredServer[]) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelSweep?.();
      cancelSweep = null;
      // Forgotten rather than kept: everything here is a claim about a network
      // this hub has stopped listening to.
      heard.clear();
      listeners.clear();
      receiver.close();
      logger.info('no longer listening for servers');
    },
  };
}
