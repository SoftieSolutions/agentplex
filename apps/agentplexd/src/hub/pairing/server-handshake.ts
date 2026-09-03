import {
  checkProtocolVersion,
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type HubId,
  type HubToServerFrame,
  type ServerId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { createFrameIdCounter } from '../../shared/ids.js';
import type { Logger } from '../../shared/logger.js';
import {
  closure,
  CLOSE_POLICY,
  type MessageSocket,
  type SocketDialer,
} from '../../shared/message-socket.js';
import type { Timers } from '../../shared/timers.js';
import type { ServerAddress } from './server-address.js';

/**
 * The hub's half of the handshake: dial a paired server and find out what is
 * on the other end.
 *
 * The hub dials, always. That is the topology decision the whole connectivity
 * design rests on — a server needs one inbound port and dials out to nothing —
 * and it is why this function exists on this side and has no counterpart on
 * the other.
 *
 * What it deliberately does not do is decide *when*. Reconnection, backoff and
 * marking a server stale belong to the connection supervisor above it; this
 * runs once, answers with what happened, and leaves a socket open only when it
 * has something worth keeping.
 */

/**
 * What is needed to dial one server. Narrower than a registration row on
 * purpose: this module has no business with labels, revocation or ids the
 * database minted, and a narrow input is one a test can build by hand.
 */
export interface DialTarget {
  readonly address: ServerAddress;
  /** The token the user typed into the hub for this server, and only this one. */
  readonly token: string;
}

export interface HandshakeDependencies {
  readonly dialer: SocketDialer;
  /** Which hub is dialling. The server cannot tell two of them apart otherwise. */
  readonly hubId: HubId;
  readonly timers: Timers;
  readonly logger: Logger;
  /**
   * How long to wait for the reply before giving up.
   *
   * A handshake with no deadline is the failure mode of every dialler that has
   * ever been written: a peer that accepts the connection and then says
   * nothing holds a socket, a supervisor slot and a pending promise forever,
   * and nothing above ever learns that the server is not answering.
   */
  readonly timeoutMs?: number;
}

/** Long enough for a sleepy box on a slow link, short enough to retry within a minute. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Why a handshake did not produce a connection.
 *
 * These are separated because they are different things to do next, not
 * because they read differently: `unreachable` and `timeout` are worth
 * retrying on a backoff, `unauthorized` and `protocol-version` are worth
 * telling the user about and not worth retrying quickly, and `protocol-error`
 * means one of the two builds is wrong.
 */
export type HandshakeFailureReason =
  'unreachable' | 'timeout' | 'unauthorized' | 'protocol-version' | 'protocol-error' | 'closed';

export type HandshakeOutcome =
  | {
      readonly ok: true;
      readonly serverId: ServerId;
      readonly stores: readonly StoreDescriptor[];
      /**
       * Left open, and the caller owns it from here. This is the point of
       * returning it: the connection the supervisor keeps is the one that
       * handshook, not a second one opened afterwards that would have to prove
       * itself all over again.
       */
      readonly socket: MessageSocket;
      /**
       * The connection's frame id counter, handed on with the socket.
       *
       * A frame id is unique within one connection and this handshake already
       * spent the first one. Anything that goes on speaking here -- the
       * heartbeat, and the reducer after it -- continues this counter rather
       * than starting its own, which would re-issue an id the peer has seen.
       */
      readonly nextFrameId: () => number;
    }
  | {
      readonly ok: false;
      readonly reason: HandshakeFailureReason;
      /** What to show the user or put in a log line. Never a token. */
      readonly problem: string;
    };

export async function handshakeWithServer(
  target: DialTarget,
  dependencies: HandshakeDependencies,
): Promise<HandshakeOutcome> {
  const { dialer, hubId, timers, logger } = dependencies;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  const dialled = await dialer.dial(target.address);
  if (!dialled.ok) {
    logger.info('server unreachable', { address: target.address, problem: dialled.problem });
    return { ok: false, reason: 'unreachable', problem: dialled.problem };
  }

  const socket = dialled.socket;
  // Per connection, because that is the only scope a frame id has to be unique
  // in. See `frames.ts` for why it is a counter and not a uuid.
  const nextFrameId = createFrameIdCounter();
  const frameId = nextFrameId();

  return new Promise<HandshakeOutcome>((resolve) => {
    let settled = false;
    let cancelTimeout: (() => void) | null = null;

    const settle = (outcome: HandshakeOutcome): void => {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      resolve(outcome);
    };

    /** Every failure closes. A socket that did not handshake is not one to keep. */
    const fail = (reason: HandshakeFailureReason, problem: string): void => {
      socket.close(closure(CLOSE_POLICY, problem));
      settle({ ok: false, reason, problem });
    };

    // Typed on the way out, so that a change to a frame's shape is a compile
    // error here rather than something the peer's parser discovers.
    const send = (frame: HubToServerFrame): void => void socket.send(JSON.stringify(frame));

    // Subscribed before the handshake is sent. A reply cannot arrive before a
    // listener exists on a real socket, and building it in the other order
    // would work here and lose the first frame the day the transport changes.
    socket.onMessage((text) => {
      if (settled) return;

      const parsed = parseTextFrame(parseServerToHubFrame, text);
      if (!parsed.ok) {
        send({ type: 'protocol-error', code: 'bad-request', message: parsed.reason });
        fail('protocol-error', `the server sent something unreadable: ${parsed.reason}`);
        return;
      }

      const frame = parsed.value;
      switch (frame.type) {
        case 'handshake-accepted': {
          if (frame.replyTo !== frameId) {
            fail('protocol-error', 'the server answered a frame this hub did not send');
            return;
          }

          // Checked on this side too, and not only on the server's. The server
          // compares the version the hub sent; this compares the version the
          // server claims. Either check alone leaves one direction of the
          // mismatch undetected.
          const mismatch = checkProtocolVersion(frame.protocolVersion);
          if (mismatch !== null) {
            fail(
              'protocol-version',
              `the server speaks protocol version ${mismatch.received}; this hub speaks ${mismatch.expected}`,
            );
            return;
          }

          logger.info('handshake accepted', {
            address: target.address,
            serverId: frame.serverId,
            stores: frame.stores.length,
          });
          settle({
            ok: true,
            serverId: frame.serverId,
            stores: frame.stores,
            socket,
            nextFrameId,
          });
          return;
        }

        case 'handshake-rejected': {
          if (frame.replyTo !== frameId) {
            fail('protocol-error', 'the server answered a frame this hub did not send');
            return;
          }
          fail(frame.reason, refusalText(frame.reason));
          return;
        }

        case 'protocol-error': {
          fail('protocol-error', `the server could not read this hub's frame: ${frame.message}`);
          return;
        }

        case 'pong': {
          // Nothing has been asked yet, so nothing can be answered.
          fail('protocol-error', 'the server replied before the handshake was answered');
          return;
        }
      }
    });

    socket.onClose((ended) => {
      // Only meaningful while unsettled: after a success the supervisor owns
      // this socket and its closes are its business, and after a failure this
      // is the close that failure asked for.
      settle({
        ok: false,
        reason: 'closed',
        problem: `the server closed the connection before answering (${ended.code} ${ended.reason})`,
      });
    });

    cancelTimeout = timers.schedule(timeoutMs, () => {
      fail('timeout', `the server accepted the connection but did not answer in ${timeoutMs}ms`);
    });

    send({
      type: 'handshake',
      id: frameId,
      protocolVersion: PROTOCOL_VERSION,
      hubId,
      token: target.token,
    });
  });
}

/**
 * A rejection carries a code and no detail, on purpose: a server that
 * explained which half of the credential was wrong would be an oracle for
 * guessing the other half. These are the hub's own words for the two codes.
 */
function refusalText(reason: 'unauthorized' | 'protocol-version'): string {
  return reason === 'unauthorized'
    ? "the server refused this hub's token; pair again with the token the server printed"
    : `the server does not speak protocol version ${PROTOCOL_VERSION}`;
}
