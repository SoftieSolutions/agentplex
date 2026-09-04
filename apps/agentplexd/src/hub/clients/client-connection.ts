import {
  checkProtocolVersion,
  parseClientFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type FrameId,
  type HubFrame,
  type HubId,
  type Layout,
  type RefusalCode,
  type SessionHolder,
} from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import type { SessionControl } from '../sessions/session-control.js';
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
  /**
   * The stored layout, read when a client asks for one.
   *
   * A function rather than a value, and read per request rather than cached
   * beside the state: the layout changes when the user rearranges their tree,
   * not when a server reports, so it has neither the machine state's version
   * nor its schedule. Encoding it once for everybody would be wrong anyway --
   * this is the one thing the hub sends that is not the same for every client.
   */
  readonly readLayout: () => Promise<Layout>;
  /**
   * The stored pane layout: characters the hub keeps and never parses.
   *
   * Two functions and no cache, for the reason `readLayout` gives. What is
   * different here is what the hub knows about the value: nothing. The split
   * arrangement's shape rules live in the web client, and the hub's promise is
   * to answer back exactly the characters the last save carried — so a new
   * pane type is a client release, never a service one.
   */
  readonly readPaneLayout: () => Promise<string | null>;
  readonly writePaneLayout: (layout: string) => Promise<void>;
  /**
   * Starting and stopping sessions.
   *
   * A seam rather than a reducer and a supervisor reached directly, because
   * what a client may ask for is one decision and this file is not where it
   * lives: the routing sees the whole fleet, and a connection sees one socket.
   */
  readonly sessions: SessionControl;
  /** Called once when this connection ends, so the broadcast can forget it. */
  readonly onClosed?: () => void;
}

/** The one place a hub frame becomes characters. */
export function encodeHubFrame(frame: HubFrame): string {
  return JSON.stringify(frame);
}

export function serveClientConnection(
  socket: MessageSocket,
  {
    hubId,
    logger,
    currentState,
    readLayout,
    readPaneLayout,
    writePaneLayout,
    sessions,
    onClosed,
  }: ClientConnectionDependencies,
): ClientConnection {
  let state: ClientConnectionState = 'awaiting-hello';
  let lastVersion: number | null = null;

  const send = (frame: HubFrame): void => void socket.send(encodeHubFrame(frame));

  const refuse = (
    replyTo: FrameId,
    code: RefusalCode,
    message: string,
    holder: SessionHolder | null = null,
  ): void => send({ type: 'refusal', replyTo, code, message, holder });

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
        // The reply names the frame that asked and reaches that client alone.
        // No other client is told that somebody asked for a layout, because a
        // layout is one person's arrangement of their own screen.
        //
        // Not awaited, and it cannot be: reading the tree is a database round
        // trip and this handler is what `onMessage` calls. Awaiting here would
        // stall every later frame on this socket behind one read.
        void answerLayout(frame.id);
        return;
      }

      case 'pane-layout-request': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // A reply to the asking client alone, like the node tree's, and not
        // awaited for the same reason: a database round trip must not stall
        // every later frame on this socket.
        void answerPaneLayout(frame.id);
        return;
      }

      case 'pane-layout-save': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerPaneLayoutSave(frame.id, frame.layout);
        return;
      }

      case 'session-start': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, and it cannot be: a start dials a server, waits for it
        // to fork a process, and answers. Awaiting here would stall every later
        // frame on this socket -- including this client's own stop -- behind
        // one instruction on another machine.
        void answerStart(frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
          provider: frame.provider,
          prompt: frame.prompt,
          server: frame.server,
        });
        return;
      }

      case 'session-stop': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerStop(frame.id, { storeId: frame.storeId, sessionId: frame.sessionId });
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

  /**
   * Reads the stored layout and replies to the client that asked.
   *
   * The state check is repeated after the await, because the socket can close
   * while the tree is being read and sending on a closed socket is an error
   * this connection would then have to explain.
   *
   * A read that throws is `internal` rather than `refused`, and the difference
   * is what a client does next. `refused` says the hub understood and declined,
   * which invites nothing; `internal` says the hub broke and retrying may work,
   * which is true -- a busy timeout on the write lock is the ordinary cause.
   * The problem is logged here and not sent: what went wrong inside the hub's
   * database is not a client's to render.
   */
  async function answerLayout(replyTo: FrameId): Promise<void> {
    try {
      const nodes = await readLayout();
      if (state !== 'established') return;
      send({ type: 'layout', replyTo, nodes });
    } catch (error) {
      logger.error('could not read the layout', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not read its layout');
    }
  }

  /**
   * Answers the stored pane layout — the characters of the last save, or
   * `null` when nothing was ever saved — to the client that asked. A throw is
   * `internal` for the reason `answerLayout` gives: the hub broke, retrying
   * may work, and what broke is not a client's to render.
   */
  async function answerPaneLayout(replyTo: FrameId): Promise<void> {
    try {
      const layout = await readPaneLayout();
      if (state !== 'established') return;
      send({ type: 'pane-layout', replyTo, layout });
    } catch (error) {
      logger.error('could not read the pane layout', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not read its pane layout');
    }
  }

  /**
   * Stores the pane layout, whole and unread, and acknowledges the client
   * that saved it. The parser already held the frame to the protocol's bound;
   * nothing here looks inside the characters, which is the contract that lets
   * a newer client save a pane type this build has never heard of.
   */
  async function answerPaneLayoutSave(replyTo: FrameId, layout: string): Promise<void> {
    try {
      await writePaneLayout(layout);
      if (state !== 'established') return;
      send({ type: 'pane-layout-saved', replyTo });
    } catch (error) {
      logger.error('could not store the pane layout', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not store the pane layout');
    }
  }

  /**
   * Starts a session and answers the client that asked.
   *
   * The state is checked again after the await for the reason the layout read
   * checks it: an instruction takes as long as another machine takes, and this
   * socket may have closed while it did. Nothing is undone in that case -- the
   * session really did start, and it will appear in the state every other
   * client is sent -- but there is nobody left to reply to.
   *
   * A throw is `internal` and not `refused`, and the difference is what the
   * client does next: `refused` says the hub understood and declined, which
   * invites nothing, and `internal` says the hub broke and retrying may work.
   */
  async function answerStart(
    replyTo: FrameId,
    request: Parameters<SessionControl['start']>[0],
  ): Promise<void> {
    try {
      const outcome = await sessions.start(request);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem, outcome.holder);
        return;
      }
      send({
        type: 'session-started',
        replyTo,
        storeId: outcome.storeId,
        sessionId: outcome.sessionId,
        server: outcome.server,
      });
    } catch (error) {
      logger.error('could not start a session', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not start that session');
    }
  }

  /** Stops a session and answers the client that asked. */
  async function answerStop(
    replyTo: FrameId,
    request: Parameters<SessionControl['stop']>[0],
  ): Promise<void> {
    try {
      const outcome = await sessions.stop(request);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem, outcome.holder);
        return;
      }
      send({
        type: 'session-stopped',
        replyTo,
        storeId: outcome.storeId,
        // A stop names the session it stopped, and the outcome carries the id
        // the server answered with rather than the one asked for -- the two are
        // the same, and taking the server's is one fewer place to get it wrong.
        sessionId: outcome.sessionId ?? request.sessionId,
        server: outcome.server,
      });
    } catch (error) {
      logger.error('could not stop a session', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not stop that session');
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
