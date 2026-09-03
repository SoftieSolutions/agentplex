import {
  checkProtocolVersion,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type FrameId,
  type HubToServerFrame,
  type ServerToHubFrame,
  type SessionId,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { closure, CLOSE_POLICY, type MessageSocket } from '../shared/message-socket.js';
import type { Logger } from '../shared/logger.js';
import { tokenMatches } from '../shared/tokens.js';
import type { ServerIdentity } from './server-identity.js';
import type { SessionController } from './session-control.js';

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
  /**
   * The one thing on this connection that starts and stops sessions.
   *
   * Injected rather than built here, because it holds the terminals: a
   * connection is a socket that comes and goes, and the agents this server is
   * running outlive every one of them. A hub reconnecting must find the
   * sessions it left behind, not a fresh empty manager.
   */
  readonly sessions: SessionController;
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
  { identity, stores, sessions, logger }: HubConnectionDependencies,
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
        // Every mounted store, straight away and unasked. A hub that has just
        // connected knows what this machine has mounted and nothing about what
        // is in it, and waiting for it to ask would be a second protocol for a
        // fact this server already has.
        void reportEverything();
        return;
      }

      case 'ping': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        send({ type: 'pong', replyTo: frame.id });
        return;
      }

      case 'session-start': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        // Not awaited: a start scans a store and forks a process, and awaiting
        // it inside `onMessage` would stall every later frame on this socket
        // behind one launch.
        void runStart(frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
          provider: frame.provider,
          prompt: frame.prompt,
        });
        return;
      }

      case 'session-stop': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        void runStop(frame.id, { storeId: frame.storeId, sessionId: frame.sessionId });
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

  /** Everything but a handshake needs a handshake first, and says so the same way. */
  function handshakeFirst(): void {
    send({
      type: 'protocol-error',
      code: 'bad-request',
      message: 'the first frame on a connection is a handshake',
    });
    refuse('handshake first');
  }

  /**
   * Starts a session and answers the hub that asked.
   *
   * The report goes first and the answer second, on purpose. Both travel the
   * same socket in order, so a hub that has read the answer has already read
   * the report -- which means the client waiting on the start sees the session
   * in the state it is sent, rather than an answer about a session that has not
   * appeared yet.
   */
  async function runStart(
    replyTo: FrameId,
    request: {
      readonly storeId: StoreId;
      readonly sessionId: SessionId | null;
      readonly provider: 'claude' | 'codex' | 'opencode';
      readonly prompt: string | null;
    },
  ): Promise<void> {
    let outcome;
    try {
      outcome = await sessions.start(request);
    } catch (error) {
      logger.error('could not start a session', { problem: String(error) });
      answerFailure(replyTo, 'this server could not start that session');
      return;
    }

    await reportStore(request.storeId);
    if (state !== 'established') return;

    if (!outcome.ok) {
      send({
        type: 'session-refused',
        replyTo,
        code: outcome.code,
        message: outcome.problem,
        hold: outcome.hold,
      });
      return;
    }

    send({
      type: 'session-started',
      replyTo,
      storeId: outcome.storeId,
      sessionId: outcome.sessionId,
    });
  }

  /** Stops a session and answers the hub that asked. */
  async function runStop(
    replyTo: FrameId,
    session: { readonly storeId: StoreId; readonly sessionId: SessionId },
  ): Promise<void> {
    let outcome;
    try {
      outcome = sessions.stop(session);
    } catch (error) {
      logger.error('could not stop a session', { problem: String(error) });
      answerFailure(replyTo, 'this server could not stop that session');
      return;
    }

    await reportStore(session.storeId);
    if (state !== 'established') return;

    if (!outcome.ok) {
      send({
        type: 'session-refused',
        replyTo,
        code: outcome.code,
        message: outcome.problem,
        hold: outcome.hold,
      });
      return;
    }

    send({
      type: 'session-stopped',
      replyTo,
      storeId: session.storeId,
      sessionId: session.sessionId,
    });
  }

  function answerFailure(replyTo: FrameId, message: string): void {
    if (state !== 'established') return;
    // `internal` rather than `refused`: this server broke on its own side, and
    // retrying may work. A refusal would say it understood and declined.
    send({ type: 'session-refused', replyTo, code: 'internal', message, hold: null });
  }

  /**
   * Sends one store's whole view, if this connection is still up.
   *
   * Reports are sent when this server connects and after anything it does that
   * could change what is running. A store that changes because somebody worked
   * in it outside agentplex is the store watcher's to notice, and it reports
   * through this same path when it lands.
   */
  async function reportStore(storeId: StoreId): Promise<void> {
    try {
      const report = await sessions.report(storeId);
      if (report === null || state !== 'established') return;
      send({
        type: 'store-report',
        storeId: report.storeId,
        sessions: [...report.sessions],
        holding: [...report.holding],
      });
    } catch (error) {
      // A scan that failed costs the report and nothing else. The hub keeps
      // the last one it had, labelled with its age, which is the honest state
      // of a store this server could not read just now.
      logger.warn('could not report a store', { storeId, problem: String(error) });
    }
  }

  async function reportEverything(): Promise<void> {
    for (const store of stores) await reportStore(store.storeId);
  }

  return {
    get state(): HubConnectionState {
      return state;
    },
  };
}
