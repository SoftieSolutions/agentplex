import {
  assertNever,
  checkClientProtocolVersion,
  parseClientFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  type ClientFrame,
  type FrameId,
  type GraphRunState,
  type HubFrame,
  type NodeId,
  type RefusalCode,
  type SessionHolder,
} from '@agentplex/protocol';
import {
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type MessageSocket,
  type SocketClosure,
} from '@agentplex/node-shared';
import type { TerminalClient } from '../terminal/terminal.js';
import type {
  ClientConnectionDependencies,
  EncodedMachineState,
} from './connection-dependencies.js';
import {
  addPolicyRule,
  answerApproval,
  answerPair,
  answerPolicy,
  answerPushSubscribe,
  answerPushUnsubscribe,
  answerUnpair,
  removePolicyRule,
} from './handle-approvals-servers-push.js';
import {
  answerDocCreate,
  answerDocOpen,
  answerDocSave,
  answerGraphCreate,
  answerGraphOpen,
  answerGraphPublish,
  answerGraphRun,
  answerGraphRunCancel,
  answerGraphRunHistory,
  answerGraphRunOpen,
  answerGraphRunRead,
  answerGraphSave,
  answerGraphSimulate,
} from './handle-docs-graphs.js';
import {
  answerAttention,
  answerPause,
  answerRetake,
  answerStart,
  answerStop,
  answerTranscript,
} from './handle-sessions.js';
import {
  answerCatalogueQuery,
  answerCreateFolder,
  answerDirectoryList,
  answerLayout,
  answerPaneLayout,
  answerPaneLayoutSave,
  answerProjectCreate,
  answerTreeChange,
} from './handle-tree.js';
import { refusal, type ReplyContext } from './reply.js';

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
 * The most graphs one connection is sent run states for.
 *
 * A connection is marked as watching a graph when it opens, runs or reads
 * one, and a tab left open for a week on a big project would otherwise
 * collect every graph in it and be sent every run on the hub, hundreds of
 * step records a frame. Sixteen is more graphs than a person has open in
 * tabs; the one asked about longest ago is forgotten first, and asking about
 * a graph again moves it to the front. A screen that has been forgotten asks
 * again when it next opens or reconnects, which is what marks it again.
 */
export const WATCHED_GRAPHS_MAX = 16;

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
   * Tells this client where a run is, if it is established and has asked
   * about that run's graph on this connection: opened it, run it, or read
   * its run.
   *
   * Unsolicited, like the tree change above it, but not to every client: a
   * run is one fact about the hub and two tabs open on the graph must read
   * the same step, while a tab open on something else has no use for it. It
   * is not small, either -- a state carries every step record so far, up to
   * `GRAPH_RUN_STEPS_MAX` of them with a bounded output each, so a run in a
   * large graph is tens of kilobytes on every change. Not encoded once for
   * everybody, because the rule about identical characters protects a state
   * clients could disagree about, and a client that missed a frame here is
   * told everything by the next one.
   */
  graphRunState(state: GraphRunState): void;
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
    attention,
    approvals,
    approvalPolicy,
    pairing,
    syncServers,
    projects,
    catalogue,
    docs,
    graphs,
    graphRuns,
    terminal,
    push,
    onClosed,
  }: ClientConnectionDependencies,
): ClientConnection {
  let state: ClientConnectionState = 'awaiting-hello';
  let lastVersion: number | null = null;
  /**
   * The graphs this client has asked about, which is what run states are
   * fanned out by. In the order they were last asked about, oldest first, and
   * bounded by `WATCHED_GRAPHS_MAX`.
   */
  const watchedGraphs = new Set<NodeId>();

  function watch(nodeId: NodeId): void {
    // Deleted first so that a graph asked about again moves to the end.
    watchedGraphs.delete(nodeId);
    watchedGraphs.add(nodeId);
    while (watchedGraphs.size > WATCHED_GRAPHS_MAX) {
      const oldest = watchedGraphs.values().next().value;
      if (oldest === undefined) break;
      watchedGraphs.delete(oldest);
    }
  }

  const send = (frame: HubFrame): void => void socket.send(encodeHubFrame(frame));

  /**
   * This socket, as the relay addresses it.
   *
   * One object for the life of the connection, because it is the identity the
   * relay files subscriptions and start handles under: a fresh one per frame
   * would be a new client every time somebody typed. It is narrower than this
   * connection deliberately -- the relay may put a frame on this socket and ask
   * how far behind it is, and may not close it or decide what it has proved.
   *
   * `bufferedBytes` is read through rather than captured: it is the reading the
   * relay drops against, and a number copied once would be the backlog as it
   * stood when the client said hello.
   */
  const watcher: TerminalClient = {
    send(frame: HubFrame): void {
      if (state !== 'established') return;
      send(frame);
    },
    get bufferedBytes(): number {
      return socket.bufferedBytes;
    },
  };

  const refuse = (
    replyTo: FrameId,
    code: RefusalCode,
    message: string,
    holder: SessionHolder | null = null,
  ): void => send(refusal(replyTo, code, message, holder));

  /** What an answer may do with this connection: reply, and ask if anyone is left. */
  const ctx: ReplyContext = {
    send,
    refuse,
    isEstablished: () => state === 'established',
    logger,
  };

  const end = (reason: SocketClosure): void => {
    state = 'closed';
    socket.close(reason);
  };

  socket.onClose((ended) => {
    const wasEstablished = state === 'established';
    state = 'closed';
    // A socket closing is a detach, and it is the same detach the
    // `session-unsubscribe` frame takes. Nothing here closes a terminal: the
    // agents this client was watching go on working, which is the whole
    // difference between closing a tab and stopping a session. It is also the
    // only path a client that crashed ever takes, so it is where the count a
    // server evicts by is given back.
    terminal.forget(watcher);
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
    // One gate for every frame, ahead of the switch, so that a frame added to
    // the protocol is refused before hello without anybody remembering to say
    // so. `protocol-error` passes: a client that could not read the hub's
    // first frame has no other way to say so.
    if (frame.type !== 'hello' && frame.type !== 'protocol-error' && state !== 'established') {
      helloFirst(frame.id);
      return;
    }

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
        const mismatch = checkClientProtocolVersion(frame.protocolVersion);
        if (mismatch !== null) {
          refuse(
            frame.id,
            'protocol-version',
            `this hub speaks client protocol ${mismatch.expected}, not ${mismatch.received}`,
          );
          logger.warn('client refused', { reason: 'protocol-version', ...mismatch });
          end(closure(CLOSE_POLICY, `client protocol version ${mismatch.expected}`));
          return;
        }

        state = 'established';
        send({
          type: 'welcome',
          replyTo: frame.id,
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          hubId,
          // Read here rather than captured at wiring time, and `null` for a
          // hub with no push. A client cannot mint a subscription without it,
          // so it belongs on the one frame every connection starts with.
          pushPublicKey: push?.publicKey() ?? null,
        });
        // Immediately, and through the same path a broadcast takes, so that a
        // client's first state and its tenth are produced by one piece of code.
        deliver(currentState());
        // After the state, so a naming the relay re-sends to a page that
        // redialled lands on a client that already has the rows it names. The
        // relay is told which page this socket is, and that is the whole of
        // what the instance does here: it gates nothing, and is not logged.
        terminal.hello(watcher, frame.instance);
        logger.info('client established');
        return;
      }

      case 'ping':
        send({ type: 'pong', replyTo: frame.id });
        return;

      case 'layout-request':
        // The reply names the frame that asked and reaches that client alone.
        // No other client is told that somebody asked for a layout, because a
        // layout is one person's arrangement of their own screen.
        //
        // Not awaited, and it cannot be: reading the tree is a database round
        // trip and this handler is what `onMessage` calls. Awaiting here would
        // stall every later frame on this socket behind one read.
        void answerLayout(ctx, readLayout, frame.id);
        return;

      case 'pane-layout-request':
        // A reply to the asking client alone, like the node tree's, and not
        // awaited for the same reason: a database round trip must not stall
        // every later frame on this socket.
        void answerPaneLayout(ctx, readPaneLayout, frame.id);
        return;

      case 'pane-layout-save':
        void answerPaneLayoutSave(ctx, writePaneLayout, frame.id, frame.layout);
        return;

      case 'session-start':
        // Not awaited, and it cannot be: a start dials a server, waits for it
        // to fork a process, and answers. Awaiting here would stall every later
        // frame on this socket -- including this client's own stop -- behind
        // one instruction on another machine.
        void answerStart(ctx, sessions, terminal, watcher, frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
          provider: frame.provider,
          prompt: frame.prompt,
          server: frame.server,
          project: frame.project,
        });
        return;

      case 'session-stop':
        void answerStop(ctx, sessions, frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
        });
        return;

      case 'session-retake':
        // Not awaited, for the reason a start is not: the server ends a
        // process, waits to see it gone and resumes the session before it
        // answers, and every later frame on this socket must not wait on that.
        void answerRetake(ctx, sessions, frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
        });
        return;

      case 'session-pause':
      case 'session-resume':
        void answerPause(ctx, sessions, frame.id, frame.type, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
        });
        return;

      case 'session-transcript':
        // Not awaited, for the reason a document open is not: it reads a file
        // on another machine, and awaiting it here would stall every later
        // frame on this socket behind one disk somewhere else.
        void answerTranscript(ctx, sessions, frame.id, {
          storeId: frame.storeId,
          sessionId: frame.sessionId,
          count: frame.count,
        });
        return;

      case 'session-acknowledge':
        // Not awaited, for the reason a pane layout save is not: it writes a
        // row, and a socket whose later frames queued behind one disk write
        // would be a screen that stops taking clicks because somebody
        // dismissed a prompt.
        void answerAttention(
          ctx,
          frame.id,
          { storeId: frame.storeId, sessionId: frame.sessionId },
          () => attention.acknowledge({ storeId: frame.storeId, sessionId: frame.sessionId }),
        );
        return;

      case 'session-mute':
        void answerAttention(
          ctx,
          frame.id,
          { storeId: frame.storeId, sessionId: frame.sessionId },
          () =>
            attention.setMuted({ storeId: frame.storeId, sessionId: frame.sessionId }, frame.muted),
        );
        return;

      case 'server-pair':
        // Not awaited, for the reason a start is not: this writes a row and
        // then asks the supervisor to re-read the table, and a socket whose
        // later frames queued behind a dial would be a screen that freezes
        // because somebody paired a machine that is switched off.
        void answerPair(ctx, pairing, syncServers, frame.id, {
          label: frame.label,
          address: frame.address,
          token: frame.token,
        });
        return;

      case 'server-unpair':
        void answerUnpair(ctx, pairing, syncServers, frame.id, frame.registrationId);
        return;

      case 'directory-list':
        // Not awaited, for the reason a start is not: a browse crosses to
        // another machine and reads a disk there, and awaiting it here would
        // stall every later frame on this socket behind it -- including this
        // client's own next step up the tree.
        void answerDirectoryList(ctx, projects, frame.id, frame.server, frame.directory);
        return;

      case 'project-create':
        // Not awaited, for the reason a layout read is not: two statements
        // against the database, and awaiting them here would stall every later
        // frame on this socket behind one write.
        void answerProjectCreate(ctx, projects, frame.id, frame.name, frame.directory);
        return;

      case 'node-create-folder':
        // Not awaited, for the reason a layout read is not: these are
        // statements against the database, and awaiting one here would stall
        // every later frame on this socket behind it.
        void answerCreateFolder(ctx, catalogue, frame.id, {
          parentId: frame.parentId,
          name: frame.name,
        });
        return;

      case 'node-rename':
        // One frame for every kind, which is why there is no second case here
        // for a project: renaming is one act on the tree whatever the node is,
        // and the feature that owns the tree is the one that does it.
        void answerTreeChange(
          ctx,
          frame.id,
          'node-renamed',
          'rename that node',
          catalogue.rename(frame.nodeId, frame.name),
        );
        return;

      case 'node-move':
        void answerTreeChange(
          ctx,
          frame.id,
          'node-moved',
          'move that node',
          catalogue.move(frame.nodeId, { parentId: frame.parentId, position: frame.position }),
        );
        return;

      case 'node-remove':
        void answerTreeChange(
          ctx,
          frame.id,
          'node-removed',
          'remove that node',
          catalogue.remove(frame.nodeId),
        );
        return;

      case 'node-forget-removal':
        void answerTreeChange(
          ctx,
          frame.id,
          'node-removal-forgotten',
          'forget that removal',
          catalogue.forgetRemoval({ storeId: frame.storeId, sessionId: frame.sessionId }),
        );
        return;

      case 'catalogue-query':
        // Not awaited, for the reason a layout read is not: a query reads every
        // node and sorts them, and awaiting it here would stall every later
        // frame on this socket -- including the next page this same client is
        // about to ask for.
        void answerCatalogueQuery(ctx, catalogue, frame.id, {
          view: frame.view,
          groupBy: frame.groupBy,
          sort: frame.sort,
          filter: frame.filter,
          cursor: frame.cursor,
          limit: frame.limit,
          openProjects: frame.openProjects,
        });
        return;

      case 'doc-create':
        // Not awaited, for the reason a browse is not: a create writes a file
        // on another machine, and awaiting it here would stall every later
        // frame on this socket behind one disk somewhere else.
        void answerDocCreate(
          ctx,
          docs,
          frame.id,
          frame.projectId,
          frame.server,
          frame.name,
          frame.content,
        );
        return;

      case 'doc-save':
        void answerDocSave(ctx, docs, frame.id, frame.nodeId, frame.content);
        return;

      case 'doc-open':
        void answerDocOpen(ctx, docs, frame.id, frame.nodeId);
        return;

      case 'graph-create':
        // Not awaited, like every other frame that reaches the database: a
        // write that stalled this socket would stall every frame behind it.
        void answerGraphCreate(ctx, graphs, frame.id, frame.projectId, frame.name);
        return;

      case 'graph-open':
        watch(frame.nodeId);
        void answerGraphOpen(ctx, graphs, frame.id, frame.nodeId);
        return;

      case 'graph-save':
        void answerGraphSave(ctx, graphs, frame.id, frame.nodeId, frame.document);
        return;

      case 'graph-publish':
        void answerGraphPublish(ctx, graphs, frame.id, frame.nodeId);
        return;

      case 'graph-run':
        watch(frame.nodeId);
        void answerGraphRun(ctx, graphRuns, frame.id, frame.nodeId, frame.input);
        return;

      case 'graph-run-cancel':
        void answerGraphRunCancel(ctx, graphRuns, frame.id, frame.runId);
        return;

      case 'graph-run-read':
        watch(frame.nodeId);
        void answerGraphRunRead(ctx, graphRuns, frame.id, frame.nodeId);
        return;

      case 'graph-run-history-request':
        // A reply to the asking client alone, like the node tree's. It also
        // marks the graph watched, as a read does: the list is drawn beside
        // the run, and the run's states are how the screen knows to ask again.
        watch(frame.nodeId);
        void answerGraphRunHistory(ctx, graphRuns, frame.id, frame.nodeId);
        return;

      case 'graph-run-open':
        watch(frame.nodeId);
        void answerGraphRunOpen(ctx, graphRuns, frame.id, frame.nodeId, frame.runId);
        return;

      case 'graph-simulate':
        // Not marked watched: a simulation numbers no run and publishes no
        // state, so there is nothing about it to follow, and a watched place
        // spent on it would push out a graph this client does follow.
        void answerGraphSimulate(ctx, graphRuns, frame.id, frame.nodeId, frame.input);
        return;

      case 'session-subscribe':
        // Handed over rather than answered here, and not awaited either: the
        // relay answers where the server's reply is read, because a
        // subscription's history follows its reply in the same turn and a
        // promise would put the two out of order. See `terminal.ts`.
        terminal.subscribe(watcher, frame.id, frame.target);
        return;

      case 'session-unsubscribe':
        terminal.unsubscribe(watcher, frame.id, frame.target);
        return;

      case 'terminal-input':
        terminal.input(watcher, frame.id, frame.target, frame.data);
        return;

      case 'terminal-resize':
        terminal.resize(watcher, frame.id, frame.target, frame.size);
        return;

      case 'approval-decide':
        // Not awaited, for the reason no other handler here awaits: the answer
        // arrives when whoever holds the blocked thing says what happened --
        // a machine, which may take a minute, or this hub's own run, at once
        // -- and a socket that stalled its next frame behind that would stop
        // being a screen.
        //
        // Both kinds take the one decide path; the switch is here so that a
        // third subject is a type error at this parser rather than a frame
        // the approvals feature is handed with a kind it never routes.
        switch (frame.subject.kind) {
          case 'session':
          case 'graphRun':
            void answerApproval(ctx, approvals, frame.id, {
              subject: frame.subject,
              approvalId: frame.approvalId,
              decision: frame.decision,
            });
            return;
          default:
            return assertNever(frame.subject, 'approval subject');
        }

      case 'push-subscribe':
        // Not awaited, for the reason an acknowledgement is not: it writes a
        // row, and a socket whose later frames queued behind one disk write
        // would be a screen that stops taking clicks because somebody turned
        // notifications on.
        void answerPushSubscribe(ctx, push, frame.id, frame.subscription);
        return;

      case 'push-unsubscribe':
        void answerPushUnsubscribe(ctx, push, frame.id, frame.endpoint);
        return;

      case 'approval-policy-list':
        void answerPolicy(ctx, approvalPolicy, frame.id, frame.projectId);
        return;

      case 'approval-policy-add':
        void addPolicyRule(ctx, approvalPolicy, frame.id, frame.projectId, frame.rule);
        return;

      case 'approval-policy-remove':
        void removePolicyRule(ctx, approvalPolicy, frame.id, frame.projectId, frame.ruleId);
        return;

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
    graphRunState(run: GraphRunState): void {
      if (state !== 'established' || !watchedGraphs.has(run.nodeId)) return;
      send({ type: 'graph-run-state', ...run });
    },
    close: end,
  };
}
