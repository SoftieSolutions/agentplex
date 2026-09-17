import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseClientFrame,
  parseTextFrame,
  serverAddressSchema,
  serverRegistrationIdSchema,
  type ClientFrame,
  type FrameId,
} from '@agentplex/protocol';
import type { FrameIds } from '../store/frame-ids.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFakeTimers } from '../store/timers.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createBrowserPairingOperations } from './pairing-operations.js';

/**
 * Pairing from the browser, over a real store and a fake wire.
 *
 * Everything inbound is a frame a real hub sent -- the answer to a pairing, the
 * answer to an unpairing, and the refusal a mistyped address earns, captured in
 * `tests/hub-server/src/capture-client-fixtures.test.ts`. Nothing here is a
 * hand-written idea of what the hub says, which matters most for the refusal:
 * the screen shows its words verbatim, so the test has to be reading the words
 * the hub actually produces.
 */

const A_PAIRING = {
  label: 'gpu-box-01',
  address: serverAddressSchema.parse('wss://gpu-box-01.example:8443'),
  token: 'the-token-the-server-printed',
};
const PAIRED = serverRegistrationIdSchema.parse('registration-1');

/** Lets the ticket promise inside the store's `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A counter whose second frame -- the request under test -- carries `id`.
 *
 * A reply names the frame it answers, and these replies were captured from a
 * real conversation in which the pairing was that client's third frame and the
 * unpairing its fourth. Seeding the counter is how the store comes to mint what
 * the hub was answering; editing the captured frame to say `2` would be a
 * hand-written fixture wearing a capture's clothes.
 */
function frameIdsAnswering(id: number): FrameIds {
  let minted = 0;
  return {
    next: (): FrameId => {
      minted += 1;
      return frameIdSchema.parse(minted === 1 ? 1 : id + minted - 2);
    },
  };
}

function harness(answering = 2): {
  store: HubStore;
  sockets: ReturnType<typeof createFakeSocketFactory>;
} {
  const sockets = createFakeSocketFactory();
  let nextTicket = 0;
  const store = createHubStore({
    fetchTicket: () => Promise.resolve(`ticket-${(nextTicket += 1)}`),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: frameIdsAnswering(answering),
  });
  return { store, sockets };
}

async function connected(answering = 2): Promise<{ store: HubStore; socket: FakeSocket }> {
  const { store, sockets } = harness(answering);
  store.subscribe(() => {});
  await settle();
  const socket = sockets.sockets[0];
  if (socket === undefined) throw new Error('no socket was dialled');
  socket.open();
  socket.deliver(hubFrames.welcome);
  return { store, socket };
}

/** What the page put on the wire, read back through the hub's own parser. */
function sent(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the page sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

describe('pairing a server from the settings screen', () => {
  it('sends the pairing and answers with the registration the hub recorded', async () => {
    const { store, socket } = await connected(3);
    const pairing = createBrowserPairingOperations(store);

    const answer = pairing.pairServer(A_PAIRING);
    expect(sent(socket).at(-1)).toEqual({
      type: 'server-pair',
      id: 3,
      label: 'gpu-box-01',
      address: 'wss://gpu-box-01.example:8443',
      token: 'the-token-the-server-printed',
    });

    socket.deliver(hubFrames.serverPaired);
    // The id is the point: whoever submitted the form can find that one row
    // the moment the state carrying it lands, without matching on the address.
    await expect(answer).resolves.toEqual({ ok: true, registrationId: PAIRED });
  });

  it('refuses when the answer is not the one a pairing asked for', async () => {
    // No hub answers a pairing with an unpairing; the store's outcome type
    // covers both replies, so this path exists and says so rather than
    // claiming a registration it was never told. The frame is the captured
    // one, unedited -- it is the conversation that is contrived, not the wire.
    const { store, socket } = await connected(4);
    const pairing = createBrowserPairingOperations(store);

    const answer = pairing.pairServer(A_PAIRING);
    socket.deliver(hubFrames.serverUnpaired);

    const outcome = await answer;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('did not answer');
  });

  it('shows the hub’s own words when the hub refuses', async () => {
    const { store, socket } = await connected();
    const pairing = createBrowserPairingOperations(store);

    const answer = pairing.pairServer(A_PAIRING);
    socket.deliver(hubFrames.refusalPairing);

    const outcome = await answer;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The address parser's sentence, as a real hub produced it.
    expect(outcome.reason).toContain('wss://');
  });

  it('refuses while the connection is down, and queues nothing', async () => {
    // The rule this whole path exists for. A queued pairing would be the token
    // a server printed, sitting in this tab's memory until a connection that
    // may never come back, with nobody watching it.
    const { store, sockets } = harness();
    store.subscribe(() => {});
    await settle();
    const socket = sockets.sockets[0];
    // Opened and not established: no welcome has arrived.
    socket?.open();
    const pairing = createBrowserPairingOperations(store);

    const outcome = await pairing.pairServer(A_PAIRING);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('nothing was sent');
    expect(store.getSnapshot().commandQueue.queued).toBe(0);
    for (const text of socket?.sent ?? []) {
      expect(text).not.toContain('the-token-the-server-printed');
    }
  });

  it('answers when the connection drops before the hub does', async () => {
    // A button that spins forever is what a promise nothing settles produces,
    // and a dropped socket is the ordinary way to get one.
    const { store, socket } = await connected();
    const pairing = createBrowserPairingOperations(store);

    const answer = pairing.pairServer(A_PAIRING);
    socket.drop();

    const outcome = await answer;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('dropped');
  });
});

describe('unpairing a server from the settings screen', () => {
  it('names the registration and nothing else, and answers yes', async () => {
    const { store, socket } = await connected(4);
    const pairing = createBrowserPairingOperations(store);

    const answer = pairing.unpairServer(PAIRED);
    expect(sent(socket).at(-1)).toEqual({
      type: 'server-unpair',
      id: 4,
      registrationId: 'registration-1',
    });

    socket.deliver(hubFrames.serverUnpaired);
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it('refuses while the connection is down, saying nothing was sent', async () => {
    const { store } = harness();
    const pairing = createBrowserPairingOperations(store);

    const outcome = await pairing.unpairServer(PAIRED);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('nothing was sent');
  });
});
