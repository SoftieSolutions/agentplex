import type { HubId, Layout } from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import { closure, CLOSE_NORMAL, type MessageSocket } from '../../shared/message-socket.js';
import type { Timers } from '../../shared/timers.js';
import type { Reducer } from '../state/reducer.js';
import {
  encodeHubFrame,
  serveClientConnection,
  type ClientConnection,
  type EncodedMachineState,
} from './client-connection.js';
import { toMachineState } from './machine-state.js';

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

export interface ClientBroadcastDependencies {
  readonly hubId: HubId;
  /** The state to publish. Subscribed to once, for all clients. */
  readonly state: Reducer;
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

export interface ClientBroadcast {
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

export function startClientBroadcast(dependencies: ClientBroadcastDependencies): ClientBroadcast {
  const { hubId, state, timers, readLayout } = dependencies;
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
        text: encodeHubFrame({ type: 'machine-state', state: toMachineState(snapshot) }),
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
