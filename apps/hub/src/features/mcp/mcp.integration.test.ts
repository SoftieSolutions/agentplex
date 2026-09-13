import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, startHttpServer, type LogRecord } from '@agentplex/node-shared';
import { createUnreachableDialer, createFakeTimers } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { hubIdSchema, PROTOCOL_VERSION } from '@agentplex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDatabase } from '../../db/fake-database.js';
import type { MigrationFileSystem } from '../../db/migration-files.js';
import { startHub, type Hub } from '../../hub.js';
import { createFakeBeaconSource } from '../discovery/fake-discovery.js';
import { createFakeWebAssets } from '../web/fake-web.js';
import { createMcp, MCP_PATH } from './mcp.js';

/**
 * The endpoint over a real port, driven by a real MCP client.
 *
 * `tool-registry.test.ts` covers what a tool is and `mcp-auth.test.ts` covers
 * who gets in. This covers the thing neither can: that an agent pointed at this
 * hub's port with a bearer token can initialize, list what is there and call it,
 * over the transport an MCP client actually speaks -- and that everything else
 * reaching `/mcp` is turned away before any of it happens.
 *
 * It stands on the hub rather than on the feature so that the mounting is under
 * test too. The client socket, the ticket exchange, the PWA and this all answer
 * on one port, which is what "same origin" means and the only form in which it
 * is a fact.
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';
const HUB_ID = hubIdSchema.parse('hub-1');

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

let hub: Hub | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await hub?.stop();
  hub = undefined;
});

async function startTestHub(records: LogRecord[] = []): Promise<Hub> {
  hub = await startHub({
    database: createFakeDatabase({
      respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: HUB_ID }] }],
    }),
    logger: createLogger('debug', (record) => void records.push(record)),
    ids: { newId: () => HUB_ID },
    clock: { now: () => 1_756_000_000_000 },
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'ticket-1' },
    dialer: createUnreachableDialer(),
    discovery: createFakeBeaconSource(),
    timers: createFakeTimers(),
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    webAssets: createFakeWebAssets({ files: { 'index.html': '<!doctype html>' } }),
    host: HOST,
    port: 0,
    localServer: null,
    files: createFakeStoreFiles(),
  });
  return hub;
}

function endpoint(started: Hub): URL {
  return new URL(`http://${HOST}:${String(started.port)}${MCP_PATH}`);
}

/**
 * What an MCP client dials this hub with: the endpoint, and the token in a
 * header, which is the whole reason MCP needs no ticket.
 *
 * The assertion is the one `asTransport` in `mcp.ts` explains -- the SDK's own
 * transports are not assignable to the SDK's own `Transport` under
 * `exactOptionalPropertyTypes`, and both sides of it are declarations from the
 * same package.
 */
function bearerTransport(started: Hub, token: string): Transport {
  return new StreamableHTTPClientTransport(endpoint(started), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as Transport;
}

async function connect(started: Hub, token = CLIENT_TOKEN): Promise<Client> {
  const connecting = new Client({ name: 'mcp.integration.test', version: '0.0.0' });
  await connecting.connect(bearerTransport(started, token));
  client = connecting;
  return connecting;
}

/** A POST that is well-formed MCP, so that only the credential is in question. */
async function postToolsList(started: Hub, headers: Record<string, string>): Promise<Response> {
  return fetch(endpoint(started), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('the hub MCP endpoint', () => {
  it('initializes an MCP client on the port the UI is served from', async () => {
    const started = await startTestHub();

    const connected = await connect(started);

    expect(connected.getServerVersion()).toMatchObject({ name: 'agentplex-hub' });
    // The same port, which is the whole claim. The PWA is on it too.
    expect((await fetch(`http://${HOST}:${String(started.port)}/`)).status).toBe(200);
  });

  it('lists the tools this build has', async () => {
    const started = await startTestHub();
    const connected = await connect(started);

    const { tools } = await connected.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['hub_info']);
  });

  it('answers hub_info with the two facts a client already gets in welcome', async () => {
    // The bar for every tool: nothing here is a capability the UI lacks. Both
    // of these are in the `welcome` frame an attached client is sent before it
    // has asked for anything.
    const started = await startTestHub();
    const connected = await connect(started);

    const result = await connected.callTool({ name: 'hub_info', arguments: {} });

    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({
      hubId: HUB_ID,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('serves a second client without either having a session', async () => {
    // Stateless, demonstrated rather than described: no `Mcp-Session-Id` is
    // minted, so two agents are two independent sequences of requests and
    // neither can be handed the other's.
    const started = await startTestHub();
    const first = await connect(started);
    const second = new Client({ name: 'second', version: '0.0.0' });
    await second.connect(bearerTransport(started, CLIENT_TOKEN));

    try {
      expect((await first.listTools()).tools).toHaveLength(1);
      expect((await second.listTools()).tools).toHaveLength(1);

      const response = await postToolsList(started, { authorization: `Bearer ${CLIENT_TOKEN}` });
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(response.headers.get('content-type')).toContain('application/json');
    } finally {
      await second.close();
    }
  });

  it('refuses a request with no credential, and says nothing an MCP client can read', async () => {
    const started = await startTestHub();

    const response = await postToolsList(started, {});

    expect(response.status).toBe(401);
    // Not a JSON-RPC envelope. A caller that could parse a refusal as an MCP
    // answer would have been told the endpoint is there and what it speaks;
    // this is the same two words the ticket exchange refuses with.
    const body: unknown = await response.json();
    expect(body).toEqual({ error: 'not authorized' });
    expect(body).not.toHaveProperty('jsonrpc');
    expect(body).not.toHaveProperty('result');
  });

  it('refuses a wrong token exactly as it refuses a missing one', async () => {
    const started = await startTestHub();

    const wrong = await postToolsList(started, { authorization: `Bearer ${CLIENT_TOKEN}-nearly` });
    const missing = await postToolsList(started, {});

    expect(wrong.status).toBe(missing.status);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('logs a refusal as a path and nothing else', async () => {
    const records: LogRecord[] = [];
    const started = await startTestHub(records);

    await postToolsList(started, { authorization: `Bearer ${CLIENT_TOKEN}-nearly` });

    const refusal = records.find((record) => record.message === 'client refused');
    expect(refusal?.fields).toEqual({ path: MCP_PATH, role: 'hub' });
    // The credential never reaches a sink, in any field of any record.
    expect(JSON.stringify(records)).not.toContain(CLIENT_TOKEN);
  });

  it('refuses an unauthenticated GET without telling it which verbs exist', async () => {
    const started = await startTestHub();

    const response = await fetch(endpoint(started), { method: 'GET' });

    expect(response.status).toBe(401);
  });

  it('answers an authenticated GET with 405, which is what makes the SDK client work', async () => {
    // The client opens a notification stream after `initialize` and treats a 405
    // as "there is no stream here". Answering it through the transport instead
    // would open an SSE response that never ends, and hold this request's
    // transport open for the life of the agent.
    const started = await startTestHub();

    const response = await fetch(endpoint(started), {
      method: 'GET',
      headers: { authorization: `Bearer ${CLIENT_TOKEN}`, accept: 'text/event-stream' },
    });

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: `${MCP_PATH} takes a POST` });
  });

  it('keeps the client routes off /mcp however the web root is arranged', async () => {
    // The ordering that makes same-origin safe rather than merely true: `/mcp`
    // is matched before anything looks at a disk.
    const started = await startTestHub();

    const response = await fetch(endpoint(started), { method: 'GET' });

    expect(response.status).not.toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('stops with an MCP client connected to it', async () => {
    const started = await startTestHub();
    await connect(started);
    client = undefined;
    const url = endpoint(started);

    await started.stop();
    hub = undefined;

    // The port goes with the listener, which is the honest end state. What is
    // asserted is that stopping resolves at all once an agent has been served:
    // a transport left behind would hold the process open after everything it
    // could ask about had been shut down.
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
  });
});

/**
 * The feature on a port of its own, which is the only way to be on one side of
 * `hub.stop` rather than after all of it.
 */
describe('the MCP endpoint while the hub is stopping', () => {
  it('refuses a request that arrives after it has been closed', async () => {
    // `hub.stop` closes this before the listener, so there is a window in which
    // the port is open and the features a tool would call are being taken down
    // underneath it. A request landing there is refused rather than served
    // against half a hub -- and 503, because nothing is broken and a retry in a
    // moment finds either this hub back or nothing listening.
    const mcp = createMcp({
      hubId: HUB_ID,
      clientToken: CLIENT_TOKEN,
      logger: createLogger('debug', () => {}),
    });
    const listener = await startHttpServer(0, HOST, (request, response) => {
      void mcp.handle(request, response);
    });

    try {
      const url = new URL(`http://${HOST}:${String(listener.port)}${MCP_PATH}`);
      const served = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${CLIENT_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(served.status).toBe(200);

      await mcp.close();

      const refused = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${CLIENT_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: 'the hub is stopping' });
    } finally {
      await listener.close();
    }
  });

  it('refuses an unauthenticated request while stopping without saying it is stopping', async () => {
    // The order of the two gates: a caller that never authenticated learns
    // nothing about this hub's state, including that it has one.
    const mcp = createMcp({
      hubId: HUB_ID,
      clientToken: CLIENT_TOKEN,
      logger: createLogger('debug', () => {}),
    });
    const listener = await startHttpServer(0, HOST, (request, response) => {
      void mcp.handle(request, response);
    });

    try {
      await mcp.close();
      const response = await fetch(new URL(`http://${HOST}:${String(listener.port)}${MCP_PATH}`), {
        method: 'POST',
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'not authorized' });
    } finally {
      await listener.close();
    }
  });
});
