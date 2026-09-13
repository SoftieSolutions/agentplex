import {
  parseServerToHubFrame,
  parseTextFrame,
  type HubId,
  type ProviderReadiness,
  type ServerId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import type {
  Logger,
  MessageSocket,
  SocketClosure,
  SocketDialer,
  Timers,
} from '@agentplex/node-shared';
import { startHeartbeat } from './connection-heartbeat.js';
import { routeServerFrame, type StoreReport } from './frame-router.js';
import { createInstructionChannel } from './instruction-channel.js';
import { createStreamChannel } from './stream-channel.js';
import {
  handshakeWithServer,
  type DialTarget,
  type HandshakeFailureReason,
} from './server-handshake.js';
import type {
  InstructionOutcome,
  ServerInstruction,
  StreamInstruction,
  StreamOutcome,
  TerminalOutputFrame,
} from './servers.js';

/**
 * How the hub speaks to one server, once it is connected.
 *
 * This is the seam between the dial loop and the wire. Above it, `dial-loop.ts`
 * decides when to connect and what a connection's state is, and never sees a
 * socket. Below it is the one implementation there is: a `MessageSocket` with
 * the handshake in front of it, the heartbeat beside it and the frame router
 * reading it. It is the one file the Connect-over-HTTP/2 epic (AGX-224)
 * replaces, which is why it is kept to what the loop actually needs.
 *
 * `ask` stays the unary half: one instruction, one answer, awaited. `stream`
 * is the other half, added by the terminal relay (AGX-212) now that there is
 * something behind it -- this file used to name it in a comment and not declare
 * it, because an interface promising a stream nothing implements is a promise
 * the loop above could be written against and then broken.
 *
 * It is deliberately not `ask` with more frame types on it. A terminal frame is
 * answered on a different schedule and sometimes not at all, and its answer has
 * to be delivered where the frame was read rather than a microtask later --
 * `stream-channel.ts` carries that argument, and it is the reason the two
 * halves are two methods rather than one with a wider union.
 */

export interface ServerTransportHandlers {
  /** A store report the server sent unsolicited: its whole view of one store. */
  onReport(report: StoreReport): void;
  /**
   * A chunk of terminal output, as it was read off the socket.
   *
   * Called synchronously, in the order the frames arrived, which is the whole
   * of what a relay owes a terminal: the replay a subscription promised is
   * these frames, and a transport that batched or deferred them would hand a
   * client its history in an order no emulator can undo.
   */
  onOutput(output: TerminalOutputFrame): void;
}

export interface ServerTransport {
  /** Puts one instruction to the server and waits for its answer. */
  ask(instruction: ServerInstruction): Promise<InstructionOutcome>;
  /** Puts one terminal frame to the server and answers where the reply is read. */
  stream(frame: StreamInstruction, answer: (outcome: StreamOutcome) => void): void;
  /**
   * Attaches the handlers for what the server says unprompted. Called once,
   * before anything is awaited, so that nothing the server says in the
   * meantime is lost -- and a server says the most right after a handshake,
   * because accepting one is what makes it report its stores.
   */
  watch(handlers: ServerTransportHandlers): void;
  /** Resolves when the connection has ended, whichever end ended it. */
  readonly closed: Promise<void>;
  /** Closes from the hub's end. Closing twice does nothing the second time. */
  close(reason: SocketClosure): void;
}

export type ServerTransportOutcome =
  | {
      readonly ok: true;
      readonly serverId: ServerId;
      readonly stores: readonly StoreDescriptor[];
      /** What that machine says it can start, from its own startup preflight. */
      readonly providers: readonly ProviderReadiness[];
      readonly transport: ServerTransport;
    }
  | {
      readonly ok: false;
      readonly reason: HandshakeFailureReason;
      /** What to show the user or put in a log line. Never a token. */
      readonly problem: string;
    };

/** What the dial loop dials with: the seam's factory half. */
export interface ServerTransportOpener {
  open(target: DialTarget): Promise<ServerTransportOutcome>;
}

export interface MessageSocketTransportDependencies {
  readonly dialer: SocketDialer;
  /** Which hub is dialling. The server cannot tell two of them apart otherwise. */
  readonly hubId: HubId;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly instructionTimeoutMs?: number;
}

/** The transport as it exists today: a handshake, then frames on a socket. */
export function createMessageSocketTransports(
  dependencies: MessageSocketTransportDependencies,
): ServerTransportOpener {
  const { dialer, hubId, timers, logger } = dependencies;

  return {
    async open(target: DialTarget): Promise<ServerTransportOutcome> {
      const outcome = await handshakeWithServer(target, {
        dialer,
        hubId,
        timers,
        logger,
        ...(dependencies.handshakeTimeoutMs === undefined
          ? {}
          : { timeoutMs: dependencies.handshakeTimeoutMs }),
      });
      if (!outcome.ok) return outcome;

      return {
        ok: true,
        serverId: outcome.serverId,
        stores: outcome.stores,
        providers: outcome.providers,
        transport: overSocket(outcome.socket, outcome.nextFrameId, dependencies),
      };
    },
  };
}

function overSocket(
  socket: MessageSocket,
  nextFrameId: () => number,
  dependencies: MessageSocketTransportDependencies,
): ServerTransport {
  const { timers, logger } = dependencies;

  const channel = createInstructionChannel({
    timers,
    logger,
    nextFrameId,
    send: (frame) => void socket.send(JSON.stringify(frame)),
    ...(dependencies.instructionTimeoutMs === undefined
      ? {}
      : { instructionTimeoutMs: dependencies.instructionTimeoutMs }),
  });

  const streams = createStreamChannel({
    timers,
    logger,
    nextFrameId,
    send: (frame) => void socket.send(JSON.stringify(frame)),
  });

  let handlers: ServerTransportHandlers | null = null;

  socket.onMessage((text) => {
    const parsed = parseTextFrame(parseServerToHubFrame, text);
    // Unreadable text is not this listener's to complain about, and it is not
    // silently ignored either: the handshake's parser owns the connection's
    // protocol errors, and a server that has started talking nonsense fails
    // the heartbeat that is asking it questions on the same socket.
    if (!parsed.ok) return;
    routeServerFrame(
      parsed.value,
      {
        // A refusal is the one frame either channel may be waiting for, and
        // this is the only thing that knows which of its own ids it spent on
        // which. The instruction channel is asked first and says whether it
        // took it; a refusal neither is waiting for has outlived its deadline.
        onAnswer: (replyTo, outcome) => {
          if (channel.answer(replyTo, outcome) || outcome.ok) return;
          streams.settle(replyTo, { ok: false, code: outcome.code, problem: outcome.problem });
        },
        onStreamAnswer: (replyTo, answer) => void streams.settle(replyTo, { ok: true, answer }),
        onReport: (report) => handlers?.onReport(report),
        onOutput: (output) => handlers?.onOutput(output),
      },
      logger,
    );
  });

  // The heartbeat's counter is this connection's, continued: the handshake
  // already spent the first id, and the instructions above draw from the same
  // one.
  const heartbeat = startHeartbeat(socket, {
    timers,
    logger,
    nextFrameId,
    ...(dependencies.heartbeatIntervalMs === undefined
      ? {}
      : { intervalMs: dependencies.heartbeatIntervalMs }),
    ...(dependencies.heartbeatTimeoutMs === undefined
      ? {}
      : { timeoutMs: dependencies.heartbeatTimeoutMs }),
  });

  const closed = new Promise<void>((resolve) => {
    socket.onClose(() => {
      heartbeat.stop();
      channel.settleAll('the connection to the server ended before it answered');
      streams.settleAll('the connection to the server ended before it answered');
      resolve();
    });
  });

  return {
    ask: channel.ask,
    stream: streams.put,
    watch(attached: ServerTransportHandlers): void {
      handlers = attached;
    },
    closed,
    close(reason: SocketClosure): void {
      socket.close(reason);
    },
  };
}
