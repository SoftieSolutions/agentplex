import {
  assertNever,
  checkProtocolVersion,
  parseClientFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type DocName,
  type FrameId,
  type HubFrame,
  type HubId,
  type CatalogueQuery,
  type Layout,
  type NodeId,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
} from '@agentplex/protocol';
import {
  type Logger,
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type MessageSocket,
  type SocketClosure,
} from '@agentplex/node-shared';
import type { CatalogueQueries, TreeChanged, TreeMutations } from '../catalogue/catalogue.js';
import type { Docs } from '../docs/docs.js';
import { newServerRegistrationSchema, type Pairing } from '../pairing/pairing.js';
import type { Projects } from '../projects/projects.js';
import type { Sessions } from '../sessions/sessions.js';

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
 *
 * One switch for the direction, and it is exhaustive. It was not, and the cost
 * was silence: the four terminal frames parsed cleanly, matched no case, and
 * fell out of the bottom with no reply, no log line and no type error -- a
 * client left waiting on an answer that was never going to come. Every frame
 * the protocol carries is now named here, and one this build cannot serve is
 * refused in words rather than dropped.
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
   * Tells this client the tree changed, if it is established.
   *
   * Unsolicited and sent to every client, like the machine state -- and unlike
   * it, not encoded once for everybody, because there is nothing to encode:
   * two fields, one of which is an integer. What the rule about identical
   * characters protects is a state two clients could disagree about, and there
   * is no disagreeing about "it changed, and it is now at 7".
   */
  catalogueChanged(version: number): void;
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
  readonly sessions: Sessions;
  /**
   * Which servers this hub may dial, as the feature that owns those rows.
   *
   * The whole seam rather than two functions, because what a pairing frame
   * does is exactly what this interface says: record a pairing, or revoke one.
   * The rules about what a pairing may be -- the address parser, the label
   * bound -- are its to state, and a connection that took a pre-checked value
   * would be a second place those rules were decided.
   */
  readonly pairing: Pairing;
  /**
   * Tells the servers feature that the pairing table has changed.
   *
   * A function and not the `Servers` seam: what a connection needs is for a
   * new pairing to be dialled and a revoked one to stop, and handing a socket
   * the supervisor would also hand it `stop()`. The supervisor reads the table
   * itself -- this says only that there is something to re-read.
   */
  readonly syncServers: () => Promise<void>;
  /**
   * Projects: the rows a client makes and renames, and the browse a directory
   * is picked with.
   *
   * A seam beside the sessions one and not folded into it, because they answer
   * different questions: which machine runs this, and which directory is this.
   * The rule about what a client may see lives further down still -- on the
   * server, over roots its own operator configured -- and nothing on this file's
   * path can widen it.
   */
  readonly projects: Projects;
  /**
   * The five edits a client may make to the tree, and the query it reads part
   * of the tree with.
   *
   * Narrower than the catalogue, and deliberately not the same seam the whole
   * layout arrives on: `readLayout` above is one function answering one frame,
   * and these are the acts the feature that owns the rows decides. What this
   * file does with all of them is the same -- answer the client that asked,
   * and nobody else.
   */
  readonly catalogue: TreeMutations & CatalogueQueries;
  /**
   * Documents: the index, and the one path a write to one takes.
   *
   * A seam beside projects rather than a method on it, because they own
   * different rows and answer different questions -- which directory is this,
   * and what is in it. What matters more here is what this file may not do: it
   * calls the four functions and reaches no server, so the MCP tools of
   * AGX-244 calling the same four are the same write path and not a second one.
   */
  readonly docs: Docs;
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
    pairing,
    syncServers,
    projects,
    catalogue,
    docs,
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
          project: frame.project,
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

      case 'server-pair': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a start is not: this writes a row and
        // then asks the supervisor to re-read the table, and a socket whose
        // later frames queued behind a dial would be a screen that freezes
        // because somebody paired a machine that is switched off.
        void answerPair(frame.id, {
          label: frame.label,
          address: frame.address,
          token: frame.token,
        });
        return;
      }

      case 'server-unpair': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerUnpair(frame.id, frame.registrationId);
        return;
      }

      case 'directory-list': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a start is not: a browse crosses to
        // another machine and reads a disk there, and awaiting it here would
        // stall every later frame on this socket behind it -- including this
        // client's own next step up the tree.
        void answerDirectoryList(frame.id, frame.server, frame.directory);
        return;
      }

      case 'project-create': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a layout read is not: two statements
        // against the database, and awaiting them here would stall every later
        // frame on this socket behind one write.
        void answerProjectCreate(frame.id, frame.name, frame.directory);
        return;
      }

      case 'node-create-folder': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a layout read is not: these are
        // statements against the database, and awaiting one here would stall
        // every later frame on this socket behind it.
        void answerCreateFolder(frame.id, { parentId: frame.parentId, name: frame.name });
        return;
      }

      case 'node-rename': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // One frame for every kind, which is why there is no second case here
        // for a project: renaming is one act on the tree whatever the node is,
        // and the feature that owns the tree is the one that does it.
        void answerTreeChange(
          frame.id,
          'node-renamed',
          'rename that node',
          catalogue.rename(frame.nodeId, frame.name),
        );
        return;
      }

      case 'node-move': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerTreeChange(
          frame.id,
          'node-moved',
          'move that node',
          catalogue.move(frame.nodeId, { parentId: frame.parentId, position: frame.position }),
        );
        return;
      }

      case 'node-remove': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerTreeChange(
          frame.id,
          'node-removed',
          'remove that node',
          catalogue.remove(frame.nodeId),
        );
        return;
      }

      case 'node-forget-removal': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerTreeChange(
          frame.id,
          'node-removal-forgotten',
          'forget that removal',
          catalogue.forgetRemoval({ storeId: frame.storeId, sessionId: frame.sessionId }),
        );
        return;
      }

      case 'catalogue-query': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a layout read is not: a query reads every
        // node and sorts them, and awaiting it here would stall every later
        // frame on this socket -- including the next page this same client is
        // about to ask for.
        void answerCatalogueQuery(frame.id, {
          view: frame.view,
          groupBy: frame.groupBy,
          sort: frame.sort,
          filter: frame.filter,
          cursor: frame.cursor,
          limit: frame.limit,
        });
        return;
      }

      case 'doc-create': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Not awaited, for the reason a browse is not: a create writes a file
        // on another machine, and awaiting it here would stall every later
        // frame on this socket behind one disk somewhere else.
        void answerDocCreate(frame.id, frame.projectId, frame.server, frame.name, frame.content);
        return;
      }

      case 'doc-save': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerDocSave(frame.id, frame.nodeId, frame.content);
        return;
      }

      case 'doc-open': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        void answerDocOpen(frame.id, frame.nodeId);
        return;
      }

      case 'session-subscribe':
      case 'session-unsubscribe':
      case 'terminal-input':
      case 'terminal-resize': {
        if (state !== 'established') {
          helloFirst(frame.id);
          return;
        }
        // Parsed, understood, and declined. The terminal relay is AGX-102's
        // stack; until it lands there is nothing on the other end of these,
        // and the honest answer is a refusal the client can render rather
        // than a frame that falls out of the bottom of this switch and leaves
        // a spinner nothing will ever resolve. `refused` and not `internal`:
        // the hub is working exactly as built, and retrying changes nothing.
        refuse(frame.id, 'refused', 'this hub build does not relay terminal frames yet');
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

      default:
        // A frame the protocol carries and this switch does not name. It
        // cannot happen while this compiles, which is the point: the four
        // cases above used to be this silence.
        return assertNever(frame, 'client frame');
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
   * Answers one page of the catalogue to the client that asked.
   *
   * Two kinds of no, and they are different things for a client to do. A stale
   * or foreign cursor is a `refusal` the client acts on -- it asks for the
   * first page again -- and it is `bad-request` rather than `refused` because
   * the frame named something this hub cannot serve, not a state of the world
   * that says no. A read that throws is `internal`, for the reason the layout
   * read gives: the hub broke, retrying may work, and what broke inside its
   * database is not a client's to render.
   */
  async function answerCatalogueQuery(replyTo: FrameId, request: CatalogueQuery): Promise<void> {
    try {
      const outcome = await catalogue.query(request);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({
        type: 'catalogue-page',
        replyTo,
        items: [...outcome.items],
        nextCursor: outcome.nextCursor,
        total: outcome.total,
        version: outcome.version,
      });
    } catch (error) {
      logger.error('could not read the catalogue', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not read its catalogue');
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
    request: Parameters<Sessions['start']>[0],
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

  /**
   * Records a pairing and answers the client that submitted it.
   *
   * Three answers and each says something different. A `bad-request` is the
   * form: the address is not one, or the label is empty, and the words are the
   * parser's own so the person reads what was wrong with what they typed
   * rather than "no". A `server-paired` means the row exists -- not that the
   * machine answered, which is the dial's to find out and the row's `phase` to
   * say a moment later. An `internal` is the hub's own failure, where retrying
   * may work.
   *
   * The token is written to the pairing table and appears nowhere else: not in
   * the reply, which has no field for it; not in the log line below; and not
   * in the refusal, whose words come from a parser that was handed the address
   * and the label and never the token.
   *
   * The sync is awaited before the reply, so a client that has been told
   * `server-paired` is a client whose server the hub is already dialling. The
   * dial itself is not awaited -- nothing waits for a machine to answer -- but
   * the decision to dial it has been made by the time the answer goes out.
   */
  async function answerPair(
    replyTo: FrameId,
    submitted: { readonly label: string; readonly address: string; readonly token: string },
  ): Promise<void> {
    const parsed = newServerRegistrationSchema.safeParse(submitted);
    if (!parsed.success) {
      // The parser's own sentences. They were written to be read by whoever
      // typed the address, which is exactly who is waiting for this frame.
      refuse(replyTo, 'bad-request', parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }

    try {
      const registration = await pairing.register(parsed.data);
      await syncServers();
      if (state !== 'established') return;
      send({ type: 'server-paired', replyTo, registrationId: registration.id });
    } catch (error) {
      logger.error('could not pair a server', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not record that pairing');
    }
  }

  /**
   * Revokes a pairing and answers the client that asked.
   *
   * `refused` and not `bad-request` for a registration that is not there: the
   * frame was well-formed and the hub understood it perfectly; what says no is
   * the state of the world. Unknown and already-revoked are one answer because
   * they are one outcome -- there is no live pairing to end -- and a client
   * that has just watched a row disappear from the state does not need to be
   * told which of the two it raced.
   *
   * The sync is awaited before the reply for the reason the pair's is, and it
   * matters more here: a client told `server-unpaired` must not be able to see
   * the hub still holding a connection it was told is gone.
   */
  async function answerUnpair(
    replyTo: FrameId,
    registrationId: ServerRegistrationId,
  ): Promise<void> {
    try {
      const revoked = await pairing.revoke(registrationId);
      if (revoked === null) {
        if (state !== 'established') return;
        refuse(replyTo, 'refused', 'this hub has no such server paired');
        return;
      }
      await syncServers();
      if (state !== 'established') return;
      send({ type: 'server-unpaired', replyTo });
    } catch (error) {
      logger.error('could not unpair a server', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not revoke that pairing');
    }
  }

  /**
   * Lists a directory on one server and answers the client that asked.
   *
   * The state is checked again after the await for the reason every other
   * answer here checks it: a browse takes as long as another machine takes, and
   * this socket may have closed while it did.
   *
   * A refusal carries no holder, and that is not an omission: a directory has
   * no live process to name, and `holder` is the field that means "it is
   * running over here". `null` is the honest value and the one every refusal
   * but a session's carries.
   */
  async function answerDirectoryList(
    replyTo: FrameId,
    server: ServerRegistrationId,
    directory: string | null,
  ): Promise<void> {
    try {
      const outcome = await projects.listDirectory(server, directory);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({
        type: 'directory-listing',
        replyTo,
        directory: outcome.directory,
        roots: [...outcome.roots],
        entries: [...outcome.entries],
        truncated: outcome.truncated,
      });
    } catch (error) {
      logger.error('could not list a directory', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not list that directory');
    }
  }

  /**
   * Makes a project and answers the client that asked.
   *
   * The refusal carries no holder, like every refusal but a session's: a
   * project has no live process to name. A throw is `internal` for the reason
   * every other answer here gives -- the hub broke, retrying may work, and what
   * broke inside its database is not a client's to render.
   */
  async function answerProjectCreate(
    replyTo: FrameId,
    name: string,
    directory: string,
  ): Promise<void> {
    try {
      const outcome = await projects.create({ name, directory });
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({ type: 'project-created', replyTo, nodeId: outcome.nodeId });
    } catch (error) {
      logger.error('could not create a project', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not create that project');
    }
  }

  /**
   * Makes a folder and answers the client that asked.
   *
   * Its own function rather than a case of the one below, because the yes is
   * different: a create answers with the id of what it made, which is the one
   * thing the client could not have worked out for itself.
   */
  async function answerCreateFolder(
    replyTo: FrameId,
    request: Parameters<TreeMutations['createFolder']>[0],
  ): Promise<void> {
    try {
      const outcome = await catalogue.createFolder(request);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem, outcome.holder);
        return;
      }
      send({ type: 'node-created', replyTo, nodeId: outcome.nodeId });
    } catch (error) {
      logger.error('could not create a folder', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not create that folder');
    }
  }

  /**
   * The other four tree edits, each answered by one word and nothing else.
   *
   * One function for four frames, and the reply name is an argument rather than
   * a branch, because the shape of the answer really is identical: the tree did
   * what was asked, and what the client reads next is the layout it asks for.
   * A refusal is passed through whole, `holder` included -- a removal refused
   * because a session is still running names the machine, so the client can
   * offer the stop rather than only the sentence.
   *
   * `doing` is the verb for the internal-error sentence, so a hub that broke
   * says which act broke rather than "something went wrong".
   */
  async function answerTreeChange(
    replyTo: FrameId,
    reply: 'node-renamed' | 'node-moved' | 'node-removed' | 'node-removal-forgotten',
    doing: string,
    pending: Promise<TreeChanged>,
  ): Promise<void> {
    try {
      const outcome = await pending;
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem, outcome.holder);
        return;
      }
      send({ type: reply, replyTo });
    } catch (error) {
      logger.error(`could not ${doing}`, { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', `the hub could not ${doing}`);
    }
  }

  /**
   * Makes a document on one machine and answers the client that asked.
   *
   * The reply carries the node and nothing else. There is no broadcast saying
   * the tree changed -- `catalogue-changed` is AGX-239's frame and supersedes
   * this -- so what keeps the screen honest until then is the client asking
   * for the layout again, exactly as it does after a project create.
   */
  async function answerDocCreate(
    replyTo: FrameId,
    projectId: NodeId,
    server: ServerRegistrationId,
    name: DocName,
    content: string,
  ): Promise<void> {
    try {
      const outcome = await docs.create(projectId, server, name, content);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({ type: 'doc-created', replyTo, nodeId: outcome.nodeId });
    } catch (error) {
      logger.error('could not create a document', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not create that document');
    }
  }

  /**
   * Replaces a document and answers the client that asked.
   *
   * `updatedAt` is the machine's, relayed rather than stamped here: a client
   * showing when a document was last written is describing a file, and the
   * hub's receipt time would be that answer plus however long two machines
   * took to talk.
   */
  async function answerDocSave(replyTo: FrameId, nodeId: NodeId, content: string): Promise<void> {
    try {
      const outcome = await docs.save(nodeId, content);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({ type: 'doc-saved', replyTo, updatedAt: outcome.updatedAt });
    } catch (error) {
      logger.error('could not save a document', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not save that document');
    }
  }

  /**
   * Reads a document back and answers the client that asked.
   *
   * A document on a machine that is not connected is a refusal naming that
   * machine, and the sentence comes from the feature rather than from here:
   * the hub holds no copy, and what a client renders is the reason it cannot
   * have one right now.
   */
  async function answerDocOpen(replyTo: FrameId, nodeId: NodeId): Promise<void> {
    try {
      const outcome = await docs.open(nodeId);
      if (state !== 'established') return;
      if (!outcome.ok) {
        refuse(replyTo, outcome.code, outcome.problem);
        return;
      }
      send({
        type: 'doc-content',
        replyTo,
        content: outcome.content,
        updatedAt: outcome.updatedAt,
      });
    } catch (error) {
      logger.error('could not open a document', { problem: String(error) });
      if (state !== 'established') return;
      refuse(replyTo, 'internal', 'the hub could not open that document');
    }
  }

  /** Stops a session and answers the client that asked. */
  async function answerStop(
    replyTo: FrameId,
    request: Parameters<Sessions['stop']>[0],
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
    catalogueChanged(version: number): void {
      if (state !== 'established') return;
      send({ type: 'catalogue-changed', version });
    },
    close: end,
  };
}
