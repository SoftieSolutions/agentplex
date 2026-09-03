import { createHash, timingSafeEqual } from 'node:crypto';
import {
  checkProtocolVersion,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type HubToServerFrame,
  type ServerToHubFrame,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { closure, CLOSE_POLICY, type MessageSocket } from '../shared/message-socket.js';
import type { Logger } from '../shared/logger.js';
import type { ServerIdentity } from './server-identity.js';

/**
 * The server's half of the handshake.
 *
 * A server dials out to nothing: every connection it has, a hub opened. So
 * this is the whole of what a server does with a stranger on a socket — verify
 * the token, agree the protocol version, and say who it is and what it has
 * mounted — and everything past that point belongs to a connection that has
 * already proved it may ask.
 *
 * Nothing here reads the network into a branch by hand. One parser owns this
 * direction, the discriminated union it returns is what gets switched on, and
 * a frame that does not parse never reaches a rule.
 */

export interface HubConnectionDependencies {
  readonly identity: ServerIdentity;
  /**
   * What this server has mounted, as of now.
   *
   * Passed as a value rather than read here because the server role already
   * resolved it at boot and a store that could not be read is not in the list.
   * A hub is told what is actually mounted, which is the only honest answer to
   * a question about a volume.
   */
  readonly stores: readonly StoreDescriptor[];
  readonly logger: Logger;
}

/** What a connection turned out to be, for the log line and for tests. */
export type HubConnectionState = 'awaiting-handshake' | 'established' | 'closed';

export interface HubConnection {
  readonly state: HubConnectionState;
}

/**
 * Serves one connection from a hub.
 *
 * Returns immediately; the connection lives on its listeners. What it holds is
 * a state machine of exactly two useful states, because the one thing a server
 * must never do is answer a question asked by a socket that has not
 * authenticated — and the cheapest way to guarantee that is for there to be no
 * code path from `awaiting-handshake` to anything but a handshake.
 */
export function serveHubConnection(
  socket: MessageSocket,
  { identity, stores, logger }: HubConnectionDependencies,
): HubConnection {
  let state: HubConnectionState = 'awaiting-handshake';

  const send = (frame: ServerToHubFrame): void => void socket.send(JSON.stringify(frame));

  const refuse = (reason: string): void => {
    state = 'closed';
    socket.close(closure(CLOSE_POLICY, reason));
  };

  socket.onClose((ended) => {
    const wasEstablished = state === 'established';
    state = 'closed';
    logger.info('hub connection closed', {
      code: ended.code,
      reason: ended.reason,
      established: wasEstablished,
    });
  });

  socket.onMessage((text) => {
    if (state === 'closed') return;

    const parsed = parseTextFrame(parseHubToServerFrame, text);
    if (!parsed.ok) {
      // The frame has no id to reply to — the id is one of the things that
      // failed to parse — so this is the unsolicited error frame, then a close.
      send({ type: 'protocol-error', code: 'bad-request', message: parsed.reason });
      logger.warn('unreadable frame from hub', { problem: parsed.reason });
      refuse('unreadable frame');
      return;
    }

    handle(parsed.value);
  });

  function handle(frame: HubToServerFrame): void {
    switch (frame.type) {
      case 'handshake': {
        if (state === 'established') {
          // A second handshake on one connection is a confused peer, not a
          // re-pairing: the identity of this connection is already settled and
          // changing it underneath whatever is using it has no safe meaning.
          send({
            type: 'protocol-error',
            code: 'bad-request',
            message: 'this connection has already handshaken',
          });
          refuse('duplicate handshake');
          return;
        }

        // Authenticate before anything else is compared. A peer that cannot
        // prove it may talk to this server learns one thing from every wrong
        // answer — that it was wrong — and nothing about what this build runs.
        if (!tokenMatches(frame.token, identity.token)) {
          send({ type: 'handshake-rejected', replyTo: frame.id, reason: 'unauthorized' });
          logger.warn('handshake refused', { hubId: frame.hubId, reason: 'unauthorized' });
          refuse('unauthorized');
          return;
        }

        // Exact match, never a range. Two peers either speak the same protocol
        // or they do not speak: see `version.ts` for why "close enough" is a
        // question nobody can answer afterwards.
        const mismatch = checkProtocolVersion(frame.protocolVersion);
        if (mismatch !== null) {
          send({ type: 'handshake-rejected', replyTo: frame.id, reason: 'protocol-version' });
          logger.warn('handshake refused', {
            hubId: frame.hubId,
            reason: 'protocol-version',
            ...mismatch,
          });
          refuse(`protocol version ${mismatch.expected}, not ${mismatch.received}`);
          return;
        }

        state = 'established';
        send({
          type: 'handshake-accepted',
          replyTo: frame.id,
          protocolVersion: PROTOCOL_VERSION,
          serverId: identity.serverId,
          stores: [...stores],
        });
        logger.info('hub connection established', {
          hubId: frame.hubId,
          serverId: identity.serverId,
          stores: stores.length,
        });
        return;
      }

      case 'ping': {
        if (state !== 'established') {
          send({
            type: 'protocol-error',
            code: 'bad-request',
            message: 'the first frame on a connection is a handshake',
          });
          refuse('handshake first');
          return;
        }
        send({ type: 'pong', replyTo: frame.id });
        return;
      }

      case 'protocol-error': {
        // The hub could not read something this server sent. There is no reply
        // to an unsolicited error and nothing useful to retry, so it is a log
        // line and a close.
        logger.error('hub rejected a frame', { code: frame.code, message: frame.message });
        refuse('peer reported a protocol error');
        return;
      }
    }
  }

  return {
    get state(): HubConnectionState {
      return state;
    },
  };
}

/**
 * Compares two tokens without leaking how far the comparison got.
 *
 * `timingSafeEqual` throws on differing lengths, and calling it on the raw
 * bytes would therefore turn the token's length into something an attacker can
 * read off an exception. Hashing both first makes every comparison the same
 * fixed width, so the only thing measurable is that one happened.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
