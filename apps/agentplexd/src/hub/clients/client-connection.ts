import {
  checkProtocolVersion,
  parseClientFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type FrameId,
  type HubFrame,
  type HubId,
  type RefusalCode,
} from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import {
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type MessageSocket,
  type SocketClosure,
} from '../../shared/message-socket.js';

/**
 * One client on one socket.
 *
 * Everything this connection sends is one of exactly two things, and keeping
 * them apart is the whole of the broadcast design:
 *
 *   * the machine state, which is unsolicited, whole, and identical for every
 *     client -- it arrives here already encoded, because the broadcast encodes
 *     one state once and hands the same characters to every socket;
 *   * a reply, which names the frame it answers and goes nowhere else. A
 *     refusal is a reply. It is not broadcast, and there is no code path here
 *     that could broadcast one: refusals are written by `refuse`, which takes
 *     the id of the frame being refused and touches this socket only.
 *
 * The socket arrives authenticated. How it proved that is the client websocket
 * ticket's problem, not this file's; what lands here is a peer that may talk to
 * the hub, and what this decides is what it may say.
 */

/**
 * Where a connection is.
 *
 * `awaiting-hello` exists for the reason the server's `awaiting-handshake`
 * does: the one thing that must not happen is state going to a peer that has
 * not agreed which protocol it is reading. There is no path from here to
 * anything but a hello.
 */
export type ClientConnectionState = 'awaiting-hello' | 'established' | 'closed';

/**
 * A machine-state frame, encoded once for everybody, with the version it
 * carries kept alongside so a connection can tell whether it already has it.
 */
export interface EncodedMachineState {
  readonly version: number;
  /** The output of `encodeHubFrame` on a `machine-state` frame. */
  readonly text: string;
}

export interface ClientConnection {
  readonly state: ClientConnectionState;
  /**
   * Sends the state, unless this client is not established or already has this
   * version.
   *
   * The version check is not an optimization. A client is sent the current
   * state the moment it says hello, and a broadcast scheduled just before that
   * would otherwise send it a second copy -- or, if the hub had changed again
   * in between, an older one. A client's view never goes backwards.
   */
  deliver(state: EncodedMachineState): void;
  /** Closes from the hub's end. Closing twice does nothing the second time. */
  close(reason: SocketClosure): void;
}

export interface ClientConnectionDependencies {
  readonly hubId: HubId;
  readonly logger: Logger;
  /**
   * The state as it is right now, encoded. Read at the moment this client
   * becomes established, so that a client that arrives during a quiet hour is
   * not looking at an empty screen until something happens to change.
   */
  readonly currentState: () => EncodedMachineState;
  /** Called once when this connection ends, so the broadcast can forget it. */
  readonly onClosed?: () => void;
}

/** The one place a hub frame becomes characters. */
export function encodeHubFrame(frame: HubFrame): string {
  return JSON.stringify(frame);
}

export function serveClientConnection(
  socket: MessageSocket,
  { hubId, logger, currentState, onClosed }: ClientConnectionDependencies,
): ClientConnection {
  let state: ClientConnectionState = 'awaiting-hello';
  let lastVersion: number | null = null;

  const send = (frame: HubFrame): void => void socket.send(encodeHubFrame(frame));

  const refuse = (replyTo: FrameId, code: RefusalCode, message: string): void =>
    send({ type: 'refusal', replyTo, code, message });

  const end = (reason: SocketClosure): void => {
    state = 'closed';
    socket.close(reason);
  };

  socket.onClose((ended) => {
    const wasEstablished = state === 'established';
    state = 'closed';
    logger.info('client connection closed', {
      code: ended.code,
      reason: ended.reason,
      established: wasEstablished,
    });
    onClosed?.();
  });

  socket.onMessage((text) => {
    if (state === 'closed') return;

    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) {
      // Nothing to reply to: the id is one of the things that failed to parse.
      // So it is the unsolicited error frame, and then a close.
      send({ type: 'protocol-error', code: 'bad-request', message: parsed.reason });
      logger.warn('unreadable frame from client', { problem: parsed.reason });
      end(closure(CLOSE_POLICY, 'unreadable frame'));
      return;
    }

    handle(parsed.value);
  });

  /** Everything except hello needs a hello first, and says so the same way. */
  function helloFirst(replyTo: FrameId): void {
    refuse(replyTo, 'bad-request', 'the first frame on a connection is a hello');
    end(closure(CLOSE_POLICY, 'hello first'));
  }

  function handle(frame: ClientFrame): void {
    switch (frame.type) {
      case 'hello': {
        if (state === 'established') {
          // A second hello is a confused client, not a re-greeting. The
          // connection's identity is settled and there is no safe meaning to
          // changing it underneath whatever is already reading state on it.
          refuse(frame.id, 'bad-request', 'this connection has already said hello');
          end(closure(CLOSE_POLICY, 'duplicate hello'));
          return;
        }

        // Exact match, never a range: see `version.ts` for why "close enough"
        // is a question nobody can answer afterwards.
        const mismatch = checkProtocolVersion(frame.protocolVersion);
        if (mismatch !== null) {
          refuse(
            frame.id,
            'protocol-version',
            `this hub speaks protocol ${mismatch.expected}, not ${mismatch.received}`,
          );
          logger.warn('client refused', { reason: 'protocol-version', ...mismatch });
          end(closure(CLOSE_POLICY, `protocol version ${mismatch.expected}`));
          return;
        }

        state = 'established';
        send({ type: 'welcome', replyTo: frame.id, protocolVersion: PROTOCOL_VERSION, hubId });
        // Immediately, and through the same path a broadcast takes, so that a
        // client's first state and its tenth are produced by one piece of code.
        deliver(currentState());
        logger.info('client established');
        return;
      }

      case 'ping': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        send({ type: 'pong', replyTo: frame.id });
        return;
      }

      case 'layout-request': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // The seam, and today a refusal rather than an answer: nothing stores a
        // layout yet. The node tree it is a view of is AGX-28's, and a payload
        // invented here would commit the wire to a shape designed by nothing.
        //
        // What is real now is where the answer goes. This reply names the frame
        // that asked and reaches that client alone -- no other client is told
        // that somebody asked for a layout, because a layout is one person's
        // arrangement of their own screen. When AGX-28 has somewhere to read it
        // from, the answer replaces this refusal on exactly this path, and the
        // routing it needs is already the tested behaviour.
        //
        // The connection is not closed. Being told no is an answer, not a
        // protocol violation.
        refuse(frame.id, 'refused', 'this hub does not store a layout yet');
        return;
      }

      case 'protocol-error': {
        // The client could not read something the hub sent. There is no reply
        // to an unsolicited error and nothing useful to retry: a client that
        // cannot parse the state frame will not parse the next one either.
        logger.error('client rejected a frame', { code: frame.code, message: frame.message });
        end(closure(CLOSE_NORMAL, 'client reported a protocol error'));
        return;
      }
    }
  }

  function deliver(encoded: EncodedMachineState): void {
    if (state !== 'established') return;
    if (lastVersion !== null && encoded.version <= lastVersion) return;
    lastVersion = encoded.version;
    socket.send(encoded.text);
  }

  return {
    get state(): ClientConnectionState {
      return state;
    },
    deliver,
    close: end,
  };
}
