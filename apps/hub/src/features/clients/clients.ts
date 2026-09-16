import type { HubId, Layout } from '@agentplex/protocol';
import {
  type Logger,
  closure,
  CLOSE_NORMAL,
  type MessageSocket,
  type Timers,
} from '@agentplex/node-shared';
import type { Pairing } from '../pairing/pairing.js';
import type { ClientCatalogue } from '../catalogue/catalogue.js';
import type { Docs } from '../docs/docs.js';
import type { Projects } from '../projects/projects.js';
import type { Sessions } from '../sessions/sessions.js';
import type { FleetState } from '../fleet-state/fleet-state.js';
import {
  encodeHubFrame,
  serveClientConnection,
  type ClientConnection,
  type EncodedMachineState,
} from './client-connection.js';

/**
 * Every attached client, and the one thing they are all told.
 *
 * The rule is that two clients can never disagree, and it is enforced by there
 * being nothing to disagree about. On a change the hub does not compute what
 * each client is missing; it reads the whole state, encodes it once, and hands
 * the identical characters to every socket. No deltas means no client that
 * applied a different subset of them, and it means a client that reconnects
 * needs no catch-up protocol -- it says hello and gets everything.
 *
 * Coalescing falls out of the same choice. Nothing here holds a queue of
 * snapshots, so there is no stale one to send: a change marks the broadcast
 * dirty and schedules a flush, and the flush reads the state as it is at that
 * moment. Ten changes in one turn of the loop are one frame carrying the tenth,
 * and it is not possible to send the ninth, because the ninth was never kept.
 *
 * A socket lands here already authenticated. Nothing in this file knows how it
 * proved that; the ticket exchange is the client websocket's business, and this
 * is what a socket becomes once it has passed.
 */

export interface ClientsDependencies {
  readonly hubId: HubId;
  /** The state to publish. Subscribed to once, for all clients. */
  readonly state: FleetState;
  /**
   * The stored layout, read once per client that asks.
   *
   * Not subscribed to and not cached beside the encoded state, because it is
   * not the same kind of thing: the machine state is one shared fact pushed to
   * everybody, and a layout is a reply to whoever asked. There is nothing to
   * encode once here, since there is no moment at which every client wants it.
   */
  readonly readLayout: () => Promise<Layout>;
  /**
   * The stored pane layout, read and written per client request.
   *
   * Passed through untouched for the reason `readLayout` is: a reply to
   * whoever asked, with nothing to encode once. The hub never parses the
   * characters; see `client-connection.ts`.
   */
  readonly readPaneLayout: () => Promise<string | null>;
  readonly writePaneLayout: (layout: string) => Promise<void>;
  /**
   * Starting and stopping sessions, handed to every client this serves.
   *
   * One instance for the whole broadcast rather than one per socket: which
   * machine may run a session is a fact about the fleet, and a per-client copy
   * of that decision is a second answer waiting to differ from the first.
   */
  readonly sessions: Sessions;
  /**
   * Pairing and unpairing servers, handed to every client this serves.
   *
   * One instance for the whole broadcast, like the session control and for the
   * same reason: which servers this hub may dial is one fact about the fleet,
   * and a per-socket copy of it would be a second answer waiting to differ.
   */
  readonly pairing: Pairing;
  /**
   * Tells the servers feature to re-read the pairing table.
   *
   * A function rather than the supervisor itself, so that what a client socket
   * can reach is "something changed, look again" and not `stop()`.
   */
  readonly syncServers: () => Promise<void>;
  /**
   * Browsing a server's directories, handed to every client this serves.
   *
   * One instance for the whole broadcast, for the reason the sessions seam is
   * one: which machines are reachable is a fact about the fleet, and a
   * per-socket copy of that would be a second answer waiting to differ.
   */
  readonly projects: Projects;
  /**
   * The tree a client edits, and word that it changed.
   *
   * One instance for the whole broadcast, for the reason the sessions seam is
   * one -- and one subscription, not one per socket: the tree is one shared
   * thing, and N listeners on it would be N copies of a fact that is the same
   * for everybody. What is per client is only whether it is established enough
   * to be told.
   */
  readonly catalogue: ClientCatalogue;
  /**
   * Documents, handed to every client this serves.
   *
   * One instance for the whole broadcast, for the reason the seams above are
   * one each: which machines are reachable is a fact about the fleet, and the
   * index is one set of rows. A per-socket copy of either would be a second
   * answer waiting to differ.
   */
  readonly docs: Docs;
  /**
   * The deadline seam the flush is scheduled on.
   *
   * Injected rather than `setTimeout` because coalescing is exactly the
   * behaviour worth testing -- that three changes produce one frame, and that
   * the frame carries the third -- and a test that had to race a real timer to
   * ask that would be a test that fails on a loaded machine.
   */
  readonly timers: Timers;
  readonly logger: Logger;
  /**
   * How long a change waits before it is sent.
   *
   * Zero by default: the next turn of the loop, which is enough to gather every
   * change a single batch of socket events produced without adding latency
   * anybody can perceive. It is a dependency because a hub with many servers
   * scanning at once may want a real window, and that is a deployment question
   * rather than a design one.
   */
  readonly coalesceMs?: number;
}

export interface Clients {
  /**
   * Takes an authenticated socket and serves a client on it.
   *
   * The connection is registered before it can be established, and forgotten
   * when the socket closes, whichever end closed it.
   */
  attach(socket: MessageSocket): ClientConnection;
  /** How many sockets are being served, established or not. */
  readonly attached: number;
  /**
   * Stops publishing and closes every client.
   *
   * Synchronous: there is no loop to wind down and no dial in flight. Closing a
   * socket is telling it to close.
   */
  stop(): void;
}

const DEFAULT_COALESCE_MS = 0;

export function createClients(dependencies: ClientsDependencies): Clients {
  const {
    hubId,
    state,
    timers,
    readLayout,
    readPaneLayout,
    writePaneLayout,
    sessions,
    pairing,
    syncServers,
    projects,
    catalogue,
    docs,
  } = dependencies;
  const logger = dependencies.logger.child({ part: 'broadcast' });
  const coalesceMs = dependencies.coalesceMs ?? DEFAULT_COALESCE_MS;

  const connections = new Set<ClientConnection>();

  let encoded: EncodedMachineState | null = null;
  let cancelFlush: (() => void) | null = null;
  let stopped = false;

  /**
   * The current state as characters, encoded at most once per version.
   *
   * The cache is what makes the hello path and the broadcast path produce the
   * same frame rather than two frames that happen to say the same thing, and it
   * is keyed on the version because the reducer bumps that exactly when
   * something changed.
   */
  const current = (): EncodedMachineState => {
    const snapshot = state.snapshot();
    if (encoded === null || encoded.version !== snapshot.version) {
      encoded = {
        version: snapshot.version,
        text: encodeHubFrame({ type: 'machine-state', state: state.published() }),
      };
    }
    return encoded;
  };

  /**
   * Sends the state as it is now to everybody who does not have it.
   *
   * A send that throws costs itself. One client's socket dying mid-broadcast
   * must not stop the others being told, which is the same rule the reducer
   * applies to its listeners and for the same reason: the alternative is a
   * fleet-wide stale screen caused by one closed tab.
   */
  const flush = (): void => {
    cancelFlush = null;
    if (stopped || connections.size === 0) return;

    const frame = current();
    for (const connection of connections) {
      try {
        connection.deliver(frame);
      } catch (error) {
        logger.warn('a client could not be sent the state', { problem: String(error) });
      }
    }
  };

  const unsubscribe = state.subscribe(() => {
    if (stopped || cancelFlush !== null) return;
    cancelFlush = timers.schedule(coalesceMs, flush);
  });

  /**
   * Says the tree changed, to everybody, now.
   *
   * Not coalesced and not scheduled, which is the one place this differs from
   * the state above. The state is read at flush time, so waiting a turn buys a
   * newer reading of it; this frame carries a version and no content, so
   * delaying it would buy nothing and cost the client the promptness that is
   * the entire reason it exists. A send that throws costs itself, for the
   * reason a state send does: one closed tab must not stop the rest being told.
   */
  const unwatchTree = catalogue.subscribe((version) => {
    if (stopped) return;
    for (const connection of connections) {
      try {
        connection.catalogueChanged(version);
      } catch (error) {
        logger.warn('a client could not be told the tree changed', { problem: String(error) });
      }
    }
  });

  return {
    attach(socket: MessageSocket): ClientConnection {
      // Assigned immediately below. The callback cannot run before then: a
      // close is an event, and no socket in this codebase delivers one from
      // inside the call that subscribed to it.
      let connection: ClientConnection | null = null;
      const served = serveClientConnection(socket, {
        hubId,
        logger,
        currentState: current,
        readLayout,
        readPaneLayout,
        writePaneLayout,
        sessions,
        pairing,
        syncServers,
        projects,
        catalogue,
        docs,
        onClosed: () => {
          if (connection !== null) connections.delete(connection);
        },
      });
      connection = served;
      connections.add(served);

      if (stopped) {
        // A socket that arrived during the shutdown. Registered and then closed
        // through the same path every other client took, rather than dropped on
        // the floor to be collected by nothing.
        served.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
        return served;
      }

      logger.info('client attached', { attached: connections.size });
      return served;
    },

    get attached(): number {
      return connections.size;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      unwatchTree();
      cancelFlush?.();
      cancelFlush = null;

      // Taken first, because closing a socket calls back into `onClosed` and
      // mutating the set being iterated is a bug waiting for the second client.
      const open = [...connections];
      connections.clear();
      for (const connection of open) {
        connection.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
      }
      logger.info('client broadcast stopped', { closed: open.length });
    },
  };
}
