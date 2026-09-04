import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, it } from 'vitest';
import { parseHubFrame, parseTextFrame, PROTOCOL_VERSION } from '@agentplex/protocol';
import { createFakeDatabase } from '../db/fake-database.js';
import type { MigrationFileSystem } from '../db/migration-files.js';
import { startHub, type Hub } from '../hub.js';
import { createUnreachableDialer } from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import { createFakeTimers } from '../../shared/timers.js';
import { CLIENT_SOCKET_PATH, CLIENT_TICKET_PATH } from './client-auth.js';

/**
 * Captures what a real hub says to a client, for the web store's tests.
 *
 * The web app's store tests feed hub frames into a fake socket, and those
 * frames must be captured real output rather than hand-written guesses -- a
 * hand-written fixture asserts that the store can read what its author
 * imagined the hub sends. This file starts the hub the way its own integration
 * test does, drives two client conversations over a real websocket, and writes
 * every frame the hub sent, verbatim, into a fixture module in apps/web.
 *
 * A test file so it runs under vitest, which is the one runner here that
 * resolves `.js` specifiers to `.ts` sources; gated on an environment variable
 * so an ordinary test run never rewrites a fixture behind anyone's back. To
 * re-capture -- after any change to the hub-to-client frames, in the same
 * commit that bumps PROTOCOL_VERSION -- run, from apps/agentplexd:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run src/hub/clients/capture-client-fixtures.test.ts
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

interface Client {
  send(frame: unknown): void;
  sendText(text: string): void;
  framesReceived(count: number): Promise<void>;
  closed(): Promise<void>;
  readonly received: readonly string[];
}

async function openClient(hub: Hub): Promise<Client> {
  const exchange = await fetch(`http://${HOST}:${hub.port}${CLIENT_TICKET_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  const issued = (await exchange.json()) as { ticket: string };

  const socket = new WebSocket(
    `ws://${HOST}:${hub.port}${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(issued.ticket)}`,
  );

  const received: string[] = [];
  const waiting: (() => void)[] = [];
  let ended = false;

  socket.on('message', (data: Buffer) => {
    received.push(data.toString('utf8'));
    for (const wake of waiting.splice(0)) wake();
  });
  socket.on('close', () => {
    ended = true;
    for (const wake of waiting.splice(0)) wake();
  });
  await new Promise<void>((resolve) => socket.on('open', () => resolve()));

  return {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    sendText: (text: string) => socket.send(text),
    async framesReceived(count: number): Promise<void> {
      while (received.length < count && !ended) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    async closed(): Promise<void> {
      while (!ended) await new Promise<void>((resolve) => waiting.push(resolve));
    },
    received,
  };
}

/** Labels a frame by what the parser read off it, never by what was expected. */
function labelFor(text: string): string {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
  const frame = parsed.value;
  if (frame.type === 'refusal') {
    return frame.code === 'protocol-version' ? 'refusalProtocolVersion' : 'refusal';
  }
  const labels = new Map<string, string>([
    ['welcome', 'welcome'],
    ['machine-state', 'machineState'],
    ['pong', 'pong'],
    ['layout', 'layout'],
    ['protocol-error', 'protocolError'],
  ]);
  const label = labels.get(frame.type);
  if (label === undefined) throw new Error(`no label for a ${frame.type} frame`);
  return label;
}

describe.runIf(process.env.CAPTURE_FIXTURES === '1')('capturing client fixtures', () => {
  it('drives two conversations and writes what the hub said', async () => {
    let nextTicket = 0;
    const hub = await startHub({
      database: createFakeDatabase({
        respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] }],
      }),
      logger: createLogger('error', () => {}),
      ids: { newId: () => 'hub-1' },
      clock: { now: () => 1_756_000_000_000 },
      clientToken: CLIENT_TOKEN,
      tokens: { newToken: () => `ticket-${(nextTicket += 1)}` },
      dialer: createUnreachableDialer(),
      timers: createFakeTimers(),
      migrationsDirectory: '/migrations',
      migrationFileSystem,
      host: HOST,
      port: 0,
    });

    // The first conversation, in an order a real client could have: a hello
    // (answered by a welcome and, unasked, the whole machine state), a ping, a
    // layout request, a session start nothing can satisfy (answered by a
    // refusal), and finally something that is not JSON at all, which earns the
    // unsolicited protocol-error and a close.
    const first = await openClient(hub);
    first.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await first.framesReceived(2);
    first.send({ type: 'ping', id: 2 });
    await first.framesReceived(3);
    first.send({ type: 'layout-request', id: 3 });
    await first.framesReceived(4);
    first.send({
      type: 'session-start',
      id: 4,
      storeId: 'store-observatory',
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
    });
    await first.framesReceived(5);
    first.sendText('definitely not a frame');
    await first.framesReceived(6);
    await first.closed();

    // The second conversation is one frame long: a hello claiming a protocol
    // this hub does not speak, refused with the code retrying cannot fix.
    const second = await openClient(hub);
    second.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION + 1 });
    await second.framesReceived(1);
    await second.closed();

    await hub.stop();

    const captured = new Map<string, string>();
    for (const text of [...first.received, ...second.received]) {
      captured.set(labelFor(text), text);
    }

    const entries = [...captured]
      .map(([label, text]) => `  ${label}: ${JSON.stringify(text)},`)
      .join('\n');
    const module = `/**
 * Hub frames, captured from a real hub over a real websocket.
 *
 * Generated by apps/agentplexd/src/hub/clients/capture-client-fixtures.test.ts
 * (see that file for how to re-run the capture). Never edited by hand: a
 * hand-written fixture tests that the store can read what its author imagined,
 * and these exist to test that it can read what the hub actually sends.
 * Re-capture after any change to the hub-to-client frames.
 *
 * Captured at protocol version ${PROTOCOL_VERSION}.
 */
export const hubFrames = {
${entries}
} as const;
`;

    const target = new URL('../../../../web/src/store/hub-frames.fixture.ts', import.meta.url);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, module, 'utf8');
    process.stdout.write(`wrote ${captured.size} frames to ${fileURLToPath(target)}\n`);
  });
});
