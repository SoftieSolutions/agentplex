import {
  checkProtocolVersion,
  encodeTerminalChunk,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type FrameId,
  type HubToServerFrame,
  type Provider,
  type ProviderReadiness,
  type ServerToHubFrame,
  type SessionId,
  type SessionRef,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import {
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type MessageSocket,
  type Logger,
} from '@agentplex/node-shared';
import type { GrantAuthority, GrantId, ServerIdentity } from '@agentplex/providers';
import type { HubAudience, HubMember } from './hub-audience.js';
import type { MachineLoadReader } from './machine-load.js';
import type { ProjectDocs } from './project-docs.js';
import type { SessionController } from './session-control.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  createTerminalStreams,
  type StreamOutcome,
  type TerminalDelivery,
  type TerminalOutput,
} from './terminal-streams.js';

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

/**
 * How much unsent terminal output one connection may be holding before this
 * server starts throwing chunks away.
 *
 * Per connection, because congestion is: two hubs watching the same terminal
 * are two sockets with two links, and one of them being on a phone must not
 * cost the other a single byte. The counter that goes with this is per stream
 * per connection for the same reason.
 *
 * 1 MiB. Four times one terminal's scrollback, so an ordinary burst -- a build
 * repainting, a test suite dumping a failure -- crosses whole even if the link
 * hiccups; half of the 2 MiB the terminal cap already lets a machine spend on
 * scrollback, so a wedged connection cannot cost more than the terminals it is
 * watching. Larger would not buy fidelity so much as staleness: a viewer a
 * megabyte behind is watching the past, and the output it would eventually be
 * shown has been superseded on the screen it is drawing.
 */
export const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

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
  /**
   * The terminals this server holds, for the frames that are about their bytes
   * rather than about starting and stopping them.
   *
   * The same object the controller above starts sessions into, and injected
   * here for the same reason: terminals outlive connections. What belongs to a
   * connection is only the subscriptions it opened, and those are built per
   * connection below and handed back when the socket goes.
   */
  readonly terminals: TerminalManager;
  /**
   * How this machine reads its own cpus, for the answer to a ping.
   *
   * The server's reader rather than one per connection, because the counters
   * belong to the machine: two hubs pinging are two questions about the same
   * cpus, and each is told the window its own answer covers.
   */
  readonly machineLoad: MachineLoadReader;
  /**
   * The project document store, for the three frames that read and write it.
   *
   * The server's rather than the connection's, because the folders are the
   * machine's: two hubs writing a project's notes are writing one folder,
   * and the store is what makes the second write replace the first rather
   * than race it. Nothing on this seam starts a process; see
   * `project-docs.ts` for why a document write is not an operation.
   */
  readonly docs: ProjectDocs;
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
  /**
   * Tells this hub that the server is going down and is waiting for the turns
   * it holds to end first.
   *
   * Sent rather than answered, because nobody asked: a shutdown is something
   * this machine decided, and the hub's alternative reading of the same
   * silence -- a server that stopped reporting -- is the wrong one. A
   * connection that has not handshaken or has already closed is told nothing,
   * which is not a degradation: a peer that never proved it may ask is owed no
   * facts about what is running here.
   */
  announceDraining(graceMs: number, sessions: readonly SessionRef[]): void;
  /**
   * Ends this connection because what it handshook with is no longer true, so
   * that the hub dials again and reads the facts afresh.
   *
   * A close and not a frame, because of where the facts live. `stores` and
   * `providers` are stated once, on `handshake-accepted`, and the hub holds
   * them for the life of the connection; there is no frame on this direction
   * that revises them, and a server cannot add one to a hub that is already
   * running. What there is instead is the thing the hub already does well: it
   * redials on its own, and the first frame it reads is the current answer to
   * exactly the question that went stale.
   *
   * `CLOSE_NORMAL` and a sentence, because nothing is wrong. The sessions this
   * server is running are untouched -- they outlive every connection, which is
   * the same property that makes a dropped socket a detach rather than a stop
   * -- and the cost is the hub's reconnect interval and the subscriptions this
   * connection held, which the hub takes again with the scrollback replay it
   * takes on any reattach.
   *
   * A connection that has not handshaken is left alone: it holds no fact of
   * ours to be stale, and closing it would cost a hub mid-handshake a dial for
   * nothing.
   */
  rehandshake(reason: string): void;
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
    terminals,
    machineLoad,
    docs,
    logger,
  }: HubConnectionDependencies,
): HubConnection {
  let state: HubConnectionState = 'awaiting-handshake';
  let grantId: GrantId | null = null;
  let leave: (() => void) | null = null;

  const send = (frame: ServerToHubFrame): void => void socket.send(JSON.stringify(frame));

  /**
   * This connection's subscriptions, its start handles, and the one place a
   * watch is given back.
   *
   * Per connection rather than per server, because a start handle is the id of
   * a frame on this socket and means nothing on another one, and because the
   * watches this connection took are exactly what has to be released when it
   * ends.
   */
  const streams = createTerminalStreams({
    terminals,
    // The watcher every terminal this connection attaches to is counted
    // against, so that one socket closing hands back its own watches and not
    // another connection's. The same id the audience knows this member by.
    watcher: connectionId,
    onOutput: sendOutput,
    logger,
  });

  /**
   * Bytes to a frame, unless this connection is too far behind to take them.
   *
   * The one place output becomes characters, and the one place output is
   * thrown away.
   *
   * ## Why it drops instead of pausing the pty
   *
   * node-pty can stop reading, and the kernel buffer would carry that back to
   * the child as a blocking write: nothing would be lost, and the session
   * would simply run slower. It is rejected anyway. It makes the behaviour of
   * a user's program depend on the speed of somebody's browser -- a build that
   * stalls because a phone went to sleep, a test suite whose timings move
   * because a tab was backgrounded -- and a program that runs differently when
   * nobody is watching is a worse surprise than a pane that says it is missing
   * output. The bytes here are also the cheap thing and the process is the
   * expensive one: an agent mid-edit must not be held still to spare a
   * megabyte. So the session runs at full speed, the viewer misses some of it,
   * and `droppedChunks` is what stops that from being a lie.
   *
   * ## Why it drops rather than queueing
   *
   * A queue of our own in front of the socket's queue would be the same bytes
   * held twice, and it could only drain by watching the same number this reads
   * -- so it would buy latency and a second buffer to bound, and bound nothing
   * the cap below does not. Refusing to add to the one queue that exists is
   * the same bound with one fewer copy.
   *
   * Whole chunks, never part of one: an escape sequence spans whatever
   * boundary it lands on, and a stream resumed mid-sequence paints as garbage
   * from the first character. The same rule `scrollback.ts` follows, for the
   * same reason, and it is why the bound is overshot by at most one chunk.
   *
   * The scrollback replay on a subscription does not go through here, and is
   * not gated: it is bounded already by the scrollback cap one layer down, it
   * happens once per subscription rather than at a rate, and `replayChunks`
   * promises exactly the frames that follow the reply -- a gate that dropped
   * one of them would make that count a lie.
   */
  function sendOutput(output: TerminalOutput): TerminalDelivery {
    if (state !== 'established') return 'dropped';
    // Before the encoding, which is a third of a megabyte of base64 per
    // megabyte of output: a chunk nobody can take is not worth the CPU either.
    if (socket.bufferedBytes > MAX_BUFFERED_OUTPUT_BYTES) return 'dropped';
    send({
      type: 'terminal-output',
      storeId: output.storeId,
      sessionId: output.sessionId,
      startId: output.startId,
      chunk: encodeTerminalChunk(output.chunk),
      droppedChunks: output.droppedChunks,
    });
    return 'sent';
  }

  const refuse = (reason: string): void => {
    state = 'closed';
    leave?.();
    socket.close(closure(CLOSE_POLICY, reason));
  };

  socket.onClose((ended) => {
    const wasEstablished = state === 'established';
    state = 'closed';
    // A socket closing is a detach, and it is the same detach the frame path
    // takes. Nothing here closes a terminal: the agents this connection was
    // watching go on working, which is the whole difference between a lid
    // closing and somebody stopping a session.
    //
    // Both halves of it, and before the log line, so that a socket ending on
    // its own and one this server closed take the same path off every terminal
    // it was watching: the subscriptions this connection opened, and then the
    // audience, whose departure hook is what sweeps any watch a detach missed.
    streams.detachAll();
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
        // Read here, as the ping is answered, so what goes back describes the
        // interval that just ended rather than one this server chose to
        // measure on its own schedule. A server nobody pings samples nothing.
        send({ type: 'pong', replyTo: frame.id, load: machineLoad.read() });
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

      case 'session-subscribe': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        const attached = streams.subscribe(frame.target);
        if (!attached.ok) {
          send({
            type: 'session-refused',
            replyTo: frame.id,
            code: 'refused',
            message: attached.problem,
            hold: null,
          });
          return;
        }

        const { attachment } = attached;
        send({
          type: 'session-subscribed',
          replyTo: frame.id,
          storeId: attachment.storeId,
          sessionId: attachment.sessionId,
          startId: attachment.startId,
          // Counted off the array the loop below sends, so the number cannot
          // promise a frame that is never written.
          replayChunks: attachment.replay.length,
          droppedBytes: attachment.droppedBytes,
        });
        // The history, on the frame live output uses, after the reply that
        // says how much of it is missing and how many of these frames are it.
        // One frame shape for bytes, so the reader has one path for them.
        //
        // Sent here rather than carried on the reply so that a quarter of a
        // megabyte of scrollback is not one JSON frame the peer must hold
        // whole, and synchronously, so nothing live can overtake it -- which
        // is also what makes the count above exact rather than a hint.
        for (const chunk of attachment.replay) {
          send({
            type: 'terminal-output',
            storeId: attachment.storeId,
            sessionId: attachment.sessionId,
            startId: attachment.startId,
            chunk: encodeTerminalChunk(chunk),
            // Nothing was dropped from this stream: what the scrollback threw
            // away is what `droppedBytes` above says, and this counter is
            // about the live stream that follows.
            droppedChunks: 0,
          });
        }
        return;
      }

      case 'session-unsubscribe': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        const detached = streams.unsubscribe(frame.target);
        if (!detached.ok) {
          answerStream(frame.id, detached);
          return;
        }
        send({ type: 'session-unsubscribed', replyTo: frame.id });
        return;
      }

      case 'terminal-input': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        // Answered only when it fails. A terminal acknowledges input the way
        // terminals do, by echoing it, and a reply per keystroke would double
        // the frame rate of the busiest path on the wire to restate what the
        // user can already see.
        answerStream(frame.id, streams.write(frame.target, frame.data));
        return;
      }

      case 'terminal-resize': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        answerStream(frame.id, streams.resize(frame.target, frame.size));
        return;
      }

      case 'doc-write': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        // Not awaited, like a start: a write makes a folder and replaces a
        // file, and awaiting it here would stall every later frame on this
        // socket behind one disk. The three fields go to the store and
        // nowhere else -- there is no process for them to reach.
        void runDocWrite(frame.id, {
          directory: frame.directory,
          name: frame.name,
          content: frame.content,
        });
        return;
      }

      case 'doc-read': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        void runDocRead(frame.id, { directory: frame.directory, name: frame.name });
        return;
      }

      case 'doc-list': {
        if (state !== 'established') {
          handshakeFirst();
          return;
        }
        void runDocList(frame.id, { directory: frame.directory });
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
   * Says nothing when a terminal frame worked, and why when it did not.
   *
   * The silence is the design: input and resize are answered by the terminal
   * itself, on the screen, and the case a user cannot see for themselves is
   * the one that gets a frame.
   */
  function answerStream(replyTo: FrameId, outcome: StreamOutcome): void {
    if (outcome.ok || state !== 'established') return;
    send({
      type: 'session-refused',
      replyTo,
      code: 'refused',
      message: outcome.problem,
      hold: null,
    });
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
      // This connection's own start handles, taken as each report goes out.
      takeStartTags: (storeId) => streams.takeStartTags(storeId),
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

    // The first reading of the cpu counters, thrown away. A busy share is the
    // difference between two of them, so without this the first pong would
    // carry none and a freshly connected machine would show no cpu figure for
    // a whole heartbeat. This is not a schedule: it happens once, because a hub
    // dialled in, which is the same thing every other sample here is caused by.
    machineLoad.read();

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

    // Before the report, because the report is where the tag goes: the hub is
    // owed "this start is running here" in the same breath as the start, so a
    // pending pane has something to be while the provider is still starting.
    if (outcome.ok) streams.noteStart(replyTo, outcome.terminalId);

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
   * The three document frames, each answered on its own socket and to nobody
   * else.
   *
   * Unlike a start or a stop, a document changes what no other hub is
   * watching -- there is no report to send around, because a document is not
   * a running thing and the store has no subscribers -- so the answer is the
   * whole of what happens. A refusal is `session-refused` with `hold: null`:
   * that frame's contract is "this server said no, and to which frame", and
   * the terminal frames already answer through it with no session in hand.
   *
   * Each catches what the store throws and answers `internal`, for the reason
   * `runStart` does: a promise that rejected inside a socket handler is an
   * unhandled rejection and a hub left waiting for an answer that never
   * comes.
   */
  async function runDocWrite(
    replyTo: FrameId,
    request: Parameters<ProjectDocs['write']>[0],
  ): Promise<void> {
    let outcome;
    try {
      outcome = await docs.write(request);
    } catch (error) {
      logger.error('could not write a document', { name: request.name, problem: String(error) });
      answerFailure(replyTo, 'this server could not write that document');
      return;
    }
    if (state !== 'established') return;
    if (!outcome.ok) {
      answerDocRefusal(replyTo, outcome);
      return;
    }
    send({ type: 'doc-written', replyTo, updatedAt: outcome.updatedAt });
  }

  async function runDocRead(
    replyTo: FrameId,
    request: Parameters<ProjectDocs['read']>[0],
  ): Promise<void> {
    let outcome;
    try {
      outcome = await docs.read(request);
    } catch (error) {
      logger.error('could not read a document', { name: request.name, problem: String(error) });
      answerFailure(replyTo, 'this server could not read that document');
      return;
    }
    if (state !== 'established') return;
    if (!outcome.ok) {
      answerDocRefusal(replyTo, outcome);
      return;
    }
    send({ type: 'doc-content', replyTo, content: outcome.content, updatedAt: outcome.updatedAt });
  }

  async function runDocList(
    replyTo: FrameId,
    request: Parameters<ProjectDocs['list']>[0],
  ): Promise<void> {
    let outcome;
    try {
      outcome = await docs.list(request);
    } catch (error) {
      logger.error('could not list a project', { problem: String(error) });
      answerFailure(replyTo, 'this server could not list that project');
      return;
    }
    if (state !== 'established') return;
    if (!outcome.ok) {
      answerDocRefusal(replyTo, outcome);
      return;
    }
    send({ type: 'doc-listing', replyTo, entries: [...outcome.entries] });
  }

  function answerDocRefusal(
    replyTo: FrameId,
    refusal: { readonly code: 'refused' | 'internal'; readonly problem: string },
  ): void {
    send({
      type: 'session-refused',
      replyTo,
      code: refusal.code,
      message: refusal.problem,
      hold: null,
    });
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
    // The start tags this connection owes go with it, and they are taken by
    // the audience at the moment each hub's copy is actually sent -- see
    // `takeStartTags` on the member above. One scan feeds every hub; the tags
    // do not, because a start handle is the id of a frame on one socket.
    await audience.reportToAll(storeId);
  }

  return {
    get state(): HubConnectionState {
      return state;
    },
    get grantId(): GrantId | null {
      return grantId;
    },

    announceDraining(graceMs: number, sessions: readonly SessionRef[]): void {
      if (state !== 'established') return;
      send({ type: 'server-draining', graceMs, sessions: [...sessions] });
    },

    rehandshake(reason: string): void {
      if (state !== 'established') return;
      // Marked closed here rather than left to the close event, for the reason
      // `refuse` does it: between asking a socket to close and hearing that it
      // did, nothing on this connection may still be answering as though the
      // handshake on it stood.
      state = 'closed';
      // And out of the audience in the same breath, for the same reason: a
      // connection that is closing must not be sent a store report between
      // asking the socket to close and hearing that it did.
      leave?.();
      logger.info('ending a hub connection so it re-handshakes', { reason });
      socket.close(closure(CLOSE_NORMAL, reason));
    },
  };
}
