import {
  checkProtocolVersion,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type FrameId,
  type HubToServerFrame,
  type Provider,
  type ProviderReadiness,
  type ServerToHubFrame,
  type SessionId,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { closure, CLOSE_POLICY, type MessageSocket, type Logger } from '@agentplex/node-shared';
import type { GrantAuthority, GrantId, ServerIdentity } from '@agentplex/providers';
import type { HubAudience, HubMember } from './hub-audience.js';
import type { SessionController } from './session-control.js';

/**
 * The server's half of the handshake.
 *
 * A server dials out to nothing: every connection it has, a hub opened. So
 * this is the whole of what a server does with a stranger on a socket — resolve
 * the token it presents to a grant, agree the protocol version, and say who it
 * is and what it has mounted — and everything past that point belongs to a
 * connection that has already proved it may ask.
 *
 * Nothing here reads the network into a branch by hand. One parser owns this
 * direction, the discriminated union it returns is what gets switched on, and
 * a frame that does not parse never reaches a rule.
 *
 * ## What the handshake now produces, and what it no longer trusts
 *
 * It used to compare the presented token with the one string this server holds.
 * It now resolves it to a **grant**: one record per pairing, minted by this
 * server, which an operator can revoke by name without unpairing every other
 * hub. The grant id is the key for everything per-hub this connection has --
 * the audience it belongs to, the watchers it holds, the connections a
 * revocation closes.
 *
 * `hubId` stays on the frame and stops being load-bearing. It is self-reported,
 * so a peer holding a token can claim to be any hub; it survives as a label for
 * a log line and for a person reading one, in exactly the sense a pairing's
 * label is a label. The server records the hub id it saw against the grant and,
 * when a later one disagrees, **accepts and records it** rather than refusing --
 * a hub whose database was rebuilt mints a new id and is legitimately the same
 * operator with the same token, and refusing would turn a recoverable afternoon
 * into an outage nothing explains.
 *
 * ## What a rejection says
 *
 * That the handshake failed, and no more. A revoked grant, an expired one and a
 * token nothing was ever minted for are refused identically, because a
 * rejection that distinguished them would confirm that a credential was real --
 * which is the one bit worth probing for, and the reason `handshake-rejected`
 * has the shape it has. The distinction is in the log line on this machine,
 * where the person entitled to it is.
 */

export interface HubConnectionDependencies {
  /**
   * This connection, as the watcher set and the audience name it.
   *
   * Minted by the server rather than here so that one id source mints them all,
   * and per connection rather than per grant because one grant may hold two
   * sockets at once.
   */
  readonly connectionId: string;
  /**
   * Who this server is. The `serverId` half only: the token on it is no longer
   * what a handshake is checked against, and the grant minted for it is.
   */
  readonly identity: ServerIdentity;
  /**
   * What turns a presented token into a grant, or says no.
   *
   * The narrow half of the grant store, so that nothing on a socket's path can
   * list, mint or revoke anything, and so that no value reaching this file
   * carries a verifier.
   */
  readonly grants: GrantAuthority;
  /**
   * Every hub connected to this server, including this one once it has
   * handshaken.
   *
   * Here because a store report is owed to hubs that asked for nothing: a hub
   * whose session another hub stopped has to learn it from something, and the
   * something is this. See `hub-audience.ts`.
   */
  readonly audience: HubAudience;
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
   * What each provider on this machine turned out to be, from the startup
   * preflight.
   *
   * A value for the same reason the stores are: the server role resolved it
   * once at boot, and a connection has nothing to add. Re-probing per handshake
   * would put two child processes per provider in front of every reconnection,
   * on a path a flaky network walks repeatedly.
   *
   * It is stated at the handshake rather than waited for, because the hub needs
   * it before it routes the first start. A provider that is not on this machine
   * cannot be reported at spawn time on the seam that runs it -- the pty forks
   * successfully and dies on the far side -- so if it is not said here it is not
   * said at all.
   */
  readonly providers: readonly ProviderReadiness[];
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

/**
 * What a connection turned out to be, for the log line and for tests.
 *
 * `authorizing` exists because resolving a token to a grant reads a file, and
 * a state machine with nothing between "no handshake yet" and "established"
 * would leave a window in which a second frame arrives at a connection that has
 * neither refused nor accepted. Everything but a handshake is answered here the
 * way it is before a handshake, and a second handshake is the confused peer it
 * always was.
 */
export type HubConnectionState = 'awaiting-handshake' | 'authorizing' | 'established' | 'closed';

export interface HubConnection {
  readonly state: HubConnectionState;
  /** The grant this connection authenticated with, `null` until it has. */
  readonly grantId: GrantId | null;
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
  {
    connectionId,
    identity,
    grants,
    audience,
    stores,
    providers,
    sessions,
    logger,
  }: HubConnectionDependencies,
): HubConnection {
  let state: HubConnectionState = 'awaiting-handshake';
  let grantId: GrantId | null = null;
  let leave: (() => void) | null = null;

  const send = (frame: ServerToHubFrame): void => void socket.send(JSON.stringify(frame));

  const refuse = (reason: string): void => {
    state = 'closed';
    leave?.();
    socket.close(closure(CLOSE_POLICY, reason));
  };

  socket.onClose((ended) => {
    const wasEstablished = state === 'established';
    state = 'closed';
    // Before the log line, so that a socket ending on its own and one this
    // server closed take the same path off every terminal it was watching.
    leave?.();
    logger.info('hub connection closed', {
      code: ended.code,
      reason: ended.reason,
      established: wasEstablished,
      grantId,
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
        if (state !== 'awaiting-handshake') {
          // A second handshake on one connection is a confused peer, not a
          // re-pairing: the identity of this connection is already settled — or
          // is being settled right now — and changing it underneath whatever is
          // using it has no safe meaning.
          send({
            type: 'protocol-error',
            code: 'bad-request',
            message: 'this connection has already handshaken',
          });
          refuse('duplicate handshake');
          return;
        }

        // Not awaited: resolving a grant reads a file, and awaiting it inside
        // `onMessage` would stall the socket. The state says so, so nothing
        // arriving in the meantime is answered as though this had succeeded.
        state = 'authorizing';
        void runHandshake(frame);
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

  /**
   * Resolves the grant, agrees the version, and joins the connection to the
   * audience.
   *
   * Authorization is first, before the version is even looked at. A peer that
   * cannot prove it may talk to this server learns one thing from every wrong
   * answer — that it was wrong — and nothing about what this build speaks or
   * runs.
   */
  async function runHandshake(
    frame: Extract<HubToServerFrame, { type: 'handshake' }>,
  ): Promise<void> {
    let authorized;
    try {
      authorized = await grants.authorize({ token: frame.token, hubId: frame.hubId });
    } catch (error) {
      // A grant store that threw is a server that cannot say whether this peer
      // may talk to it, and the direction that does not over-claim is to refuse
      // rather than to admit on the strength of a credential nothing checked.
      logger.error('could not resolve a grant', { hubId: frame.hubId, problem: String(error) });
      authorized = { ok: false, refusal: 'no-grant' } as const;
    }
    // The socket may have gone while the file was being read. Nothing is sent
    // down it and nothing is joined to the audience.
    if (state !== 'authorizing') return;

    if (!authorized.ok) {
      // One frame for all three refusals. `refusal` reaches this machine's log
      // and never the peer: "your access was revoked" confirms the token was
      // real, which is exactly the probing oracle this frame was shaped around.
      send({ type: 'handshake-rejected', replyTo: frame.id, reason: 'unauthorized' });
      logger.warn('handshake refused', {
        hubId: frame.hubId,
        reason: 'unauthorized',
        refusal: authorized.refusal,
      });
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
        grantId: authorized.grantId,
        reason: 'protocol-version',
        ...mismatch,
      });
      refuse(`protocol version ${mismatch.expected}, not ${mismatch.received}`);
      return;
    }

    grantId = authorized.grantId;
    state = 'established';
    const member: HubMember = {
      connectionId,
      grantId: authorized.grantId,
      send,
      close: (reason) => refuse(reason),
    };
    leave = audience.join(member);

    send({
      type: 'handshake-accepted',
      replyTo: frame.id,
      protocolVersion: PROTOCOL_VERSION,
      serverId: identity.serverId,
      stores: [...stores],
      providers: [...providers],
    });
    logger.info('hub connection established', {
      // The label the operator gave the grant, beside the name the hub gave
      // itself. Both are labels; only the first is one this server minted.
      hubId: frame.hubId,
      grantId: authorized.grantId,
      grantLabel: authorized.label,
      serverId: identity.serverId,
      stores: stores.length,
      // The states and not the whole readings: a log line says whether this
      // machine can run what it is about to be asked for, and the versions
      // and directories were logged once at boot where they belong.
      providers: providers.map((readiness) => `${readiness.provider}:${readiness.state}`),
    });

    // Every mounted store, straight away and unasked, and to this hub only. A
    // hub that has just connected knows what this machine has mounted and
    // nothing about what is in it; the hubs that were already here know both,
    // and re-sending it to them would make a flapping connection everybody
    // else's traffic.
    for (const store of stores) {
      if (state !== 'established') return;
      await audience.reportTo(member, store.storeId);
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
      readonly provider: Provider;
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
   * Sends one store's whole view to every connected hub.
   *
   * To all of them rather than to the one that asked, which is the change this
   * file exists around. Anything that alters what is running in a store alters
   * it for every hub watching that store, and a hub whose session another hub
   * stopped has no frame to be answered with: it asked nothing. A whole store
   * report is the fact rather than the answer, and it is already the shape that
   * carries it.
   *
   * Reports are sent when a hub connects and after anything this server does
   * that could change what is running. A store that changes because somebody
   * worked in it outside agentplex is the store watcher's to notice, and it
   * reports through this same path when it lands.
   */
  async function reportStore(storeId: StoreId): Promise<void> {
    await audience.reportToAll(storeId);
  }

  return {
    get state(): HubConnectionState {
      return state;
    },
    get grantId(): GrantId | null {
      return grantId;
    },
  };
}
