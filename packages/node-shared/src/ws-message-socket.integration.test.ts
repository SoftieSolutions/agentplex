import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DOC_CONTENT_MAX_CHARS, TERMINAL_CHUNK_MAX_CHARS } from '@agentplex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HTTP_TIMEOUTS, startHttpServer, type HttpListener, type UpgradeHandler } from './http.js';
import type { MessageSocket, SocketClosure } from './message-socket.js';
import {
  createWebSocketDialer,
  createWebSocketListener,
  type WebSocketListener,
} from './ws-message-socket.js';

/**
 * The real transport, on a real port.
 *
 * Every other suite drives the fake socket, which delivers a close exactly once
 * because it was written to. These are what say the `ws` wrapper does too, with
 * the codes `ws` 8 actually hands out rather than the ones a reader would guess:
 * the side that detects a bad frame closes abnormally (1006) with an empty
 * reason, so the error it recorded is the only account of why, and the peer is
 * told the RFC code for what it did wrong.
 */

const LISTENER_CAP_BYTES = 64;

/** Long enough for a second, late delivery to have landed if one were coming. */
const SETTLE_MS = 50;

let http: HttpListener | undefined;
let listener: WebSocketListener | undefined;

afterEach(async () => {
  listener?.close();
  listener = undefined;
  await http?.close();
  http = undefined;
});

interface Harness {
  readonly address: string;
  /** The next connection the listener accepts, as the seam. */
  accepted(): Promise<MessageSocket>;
}

async function listen(maxPayloadBytes = LISTENER_CAP_BYTES): Promise<Harness> {
  const waiting: ((socket: MessageSocket) => void)[] = [];
  const arrived: MessageSocket[] = [];

  listener = createWebSocketListener({
    maxPayloadBytes,
    onConnection: (socket) => {
      const next = waiting.shift();
      if (next === undefined) arrived.push(socket);
      else next(socket);
    },
  });
  http = await startHttpServer(
    0,
    '127.0.0.1',
    (_request, response) => response.end(),
    HTTP_TIMEOUTS,
    listener.onUpgrade,
  );

  return {
    address: `ws://127.0.0.1:${http.port}/`,
    accepted: () => {
      const ready = arrived.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

async function dial(address: string, maxPayloadBytes?: number): Promise<MessageSocket> {
  const result = await createWebSocketDialer(
    maxPayloadBytes === undefined ? {} : { maxPayloadBytes },
  ).dial(address);
  if (!result.ok) throw new Error(`dial failed: ${result.problem}`);
  return result.socket;
}

interface Closures {
  /** What each of two independent listeners was handed, in order. */
  readonly first: SocketClosure[];
  readonly second: SocketClosure[];
  /** Settles on the first delivery. */
  readonly closed: Promise<SocketClosure>;
}

/**
 * Two listeners, counted separately, because "once" is a promise made to each
 * subscriber: the hub's dial socket has three, and a flag shared between them
 * would hand the close to the first and starve the rest.
 */
function watch(socket: MessageSocket): Closures {
  const first: SocketClosure[] = [];
  const second: SocketClosure[] = [];
  socket.onClose((closure) => first.push(closure));
  socket.onClose((closure) => second.push(closure));
  const closed = new Promise<SocketClosure>((resolve) => socket.onClose(resolve));
  return { first, second, closed };
}

async function settled(...sides: Closures[]): Promise<void> {
  await Promise.all(sides.map((side) => side.closed));
  await delay(SETTLE_MS);
}

function expectOnce(side: Closures, expected: Partial<SocketClosure>): void {
  expect(side.first).toHaveLength(1);
  expect(side.second).toHaveLength(1);
  expect(side.first[0]).toEqual(side.second[0]);
  expect(side.first[0]).toMatchObject(expected);
}

interface RawClient {
  readonly raw: WebSocket;
  /** The TCP socket under it, for writing what `ws` itself refuses to send. */
  readonly tcp: Socket;
}

/** A raw `ws` client, for the things the seam deliberately cannot do. */
function rawClient(address: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const raw = new WebSocket(address);
    let tcp: Socket | undefined;
    raw.on('error', () => undefined);
    raw.once('upgrade', (response) => {
      tcp = response.socket;
    });
    raw.once('open', () => {
      if (tcp === undefined) reject(new Error('opened without an upgrade'));
      else resolve({ raw, tcp });
    });
    raw.once('unexpected-response', () => reject(new Error('upgrade refused')));
  });
}

describe('the websocket transport', () => {
  it('closes the listener side once when a frame passes its cap, and tells the dialer 1009', async () => {
    const harness = await listen();
    const dialled = await dial(harness.address);
    const accepted = await harness.accepted();
    const listenerSide = watch(accepted);
    const dialSide = watch(dialled);

    dialled.send('x'.repeat(LISTENER_CAP_BYTES + 1));
    await settled(listenerSide, dialSide);

    expectOnce(listenerSide, { code: 1006 });
    expect(listenerSide.first[0]?.reason).toContain('Max payload size exceeded');
    expectOnce(dialSide, { code: 1009 });
  });

  it('closes the dial side once when a frame passes the dialer cap, and tells the listener 1009', async () => {
    const harness = await listen(1_000_000);
    const dialled = await dial(harness.address, LISTENER_CAP_BYTES);
    const accepted = await harness.accepted();
    const listenerSide = watch(accepted);
    const dialSide = watch(dialled);

    accepted.send('x'.repeat(LISTENER_CAP_BYTES + 1));
    await settled(listenerSide, dialSide);

    expectOnce(dialSide, { code: 1006 });
    expect(dialSide.first[0]?.reason).toContain('Max payload size exceeded');
    expectOnce(listenerSide, { code: 1009 });
  });

  it('resolves a dial whose upgrade is refused as a failure, not a socket', async () => {
    const refuse: UpgradeHandler = (_request, socket) => socket.destroy();
    http = await startHttpServer(
      0,
      '127.0.0.1',
      (_request, response) => response.end(),
      HTTP_TIMEOUTS,
      refuse,
    );

    const result = await createWebSocketDialer().dial(`ws://127.0.0.1:${http.port}/`);

    expect(result.ok).toBe(false);
  });

  it('delivers one abnormal closure when the peer is terminated without a close frame', async () => {
    const harness = await listen();
    const { raw } = await rawClient(harness.address);
    const accepted = await harness.accepted();
    const listenerSide = watch(accepted);

    raw.terminate();
    await settled(listenerSide);

    expectOnce(listenerSide, { code: 1006 });
  });

  it('hands every open socket one closure when the listener closes', async () => {
    const harness = await listen();
    const dialledA = await dial(harness.address);
    const acceptedA = await harness.accepted();
    const dialledB = await dial(harness.address);
    const acceptedB = await harness.accepted();
    const sides = [watch(dialledA), watch(acceptedA), watch(dialledB), watch(acceptedB)];

    const closing: unknown = listener?.close();
    listener = undefined;
    await settled(...sides);

    // Synchronous, because the hub and the server both call it without waiting.
    expect(closing).toBeUndefined();
    for (const side of sides) expectOnce(side, { code: 1006 });
  });

  it('delivers an error after open once, with the close code and the error as the reason', async () => {
    const harness = await listen();
    const { raw, tcp } = await rawClient(harness.address);
    const accepted = await harness.accepted();
    const listenerSide = watch(accepted);
    const peerCodes: number[] = [];
    raw.on('close', (code) => peerCodes.push(code));

    // A masked text frame whose two bytes are not UTF-8. `ws` will not send
    // one, so it goes onto the TCP socket underneath: FIN and text, the mask
    // bit and a length of 2, a zero mask, then the payload.
    tcp.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]));
    await settled(listenerSide);

    expectOnce(listenerSide, { code: 1006 });
    expect(listenerSide.first[0]?.reason).toContain('invalid UTF-8');
    expect(peerCodes).toEqual([1007]);
  });
});

describe('the dialer frame cap', () => {
  it('carries the largest frames the protocol bounds', async () => {
    const harness = await listen();
    const dialled = await dial(harness.address);
    const accepted = await harness.accepted();
    const received: number[] = [];
    dialled.onMessage((text) => received.push(text.length));

    // A document of control characters is the worst case JSON has: six bytes
    // for every one of them. Terminal output is base64, one byte a character.
    const documentFrame = JSON.stringify({
      type: 'doc-content',
      id: 1,
      content: '\u0001'.repeat(DOC_CONTENT_MAX_CHARS),
    });
    const terminalFrame = JSON.stringify({
      type: 'terminal-output',
      data: 'A'.repeat(TERMINAL_CHUNK_MAX_CHARS),
    });
    accepted.send(documentFrame);
    accepted.send(terminalFrame);
    await expect.poll(() => received.length).toBe(2);

    expect(received).toEqual([documentFrame.length, terminalFrame.length]);
  });

  it('drops a frame past the default cap rather than buffering it', async () => {
    const harness = await listen();
    const dialled = await dial(harness.address);
    const accepted = await harness.accepted();
    const dialSide = watch(dialled);

    accepted.send('x'.repeat(16 * 1024 * 1024 + 1));
    await settled(dialSide);

    expectOnce(dialSide, { code: 1006 });
    expect(dialSide.first[0]?.reason).toContain('Max payload size exceeded');
  });
});
