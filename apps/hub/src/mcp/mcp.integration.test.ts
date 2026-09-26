import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, startHttpServer, type LogRecord } from '@agentplex/node-shared';
import { createUnreachableDialer, createFakeTimers } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { CLIENT_PROTOCOL_VERSION, hubIdSchema, SERVER_PROTOCOL_VERSION } from '@agentplex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeDatabase } from '../db/fake-database.js';
import type { MigrationFileSystem } from '../db/migration-files.js';
import { startHub, type Hub } from '../hub.js';
import { createFakeBeaconSource } from '../discovery/fake-discovery.js';
import { createFakeSessions } from '../sessions/fake-sessions.js';
import { createFakeDocs } from '../docs/fake-docs.js';
import { createFakeProjects } from '../projects/fake-projects.js';
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

/**
 * What the endpoint is given when it is stood up on a port of its own, below.
 *
 * Those two cases are about the shutdown window and the bearer gate, and reach
 * no tool at all: a hub with parts being taken down underneath it is exactly
 * when nothing should be asking a feature anything.
 */
const emptyFleet = {
  published: () => ({ version: 0, stores: [], servers: [], candidates: [], graphRunApprovals: [] }),
};
const noTerminal = { subscribe: () => {}, input: () => {}, forget: () => {} };
const noSessions = createFakeSessions();
const noDocs = createFakeDocs();
const noProjects = createFakeProjects();

/**
 * One pairing in the hub's table, so the fleet an agent lists is not empty.
 *
 * The dialer is unreachable, which is the useful state rather than a limitation
 * of the harness: what `list_servers` has to get right is that a machine
 * nobody can reach keeps its row, with the reason attached, instead of
 * disappearing.
 */
const PAIRED_SERVER = {
  id: 'registration-attic',
  label: 'attic',
  address: 'wss://attic.example:8443',
  token: 'tok-attic',
  server_id: null,
  created_at: 1_756_000_000_000,
  revoked_at: null,
  last_connected_at: null,
};

async function startTestHub(records: LogRecord[] = []): Promise<Hub> {
  hub = await startHub({
    database: createFakeDatabase({
      respondWith: [
        { match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: HUB_ID }] },
        { match: /FROM servers WHERE revoked_at IS NULL/, rows: [PAIRED_SERVER] },
      ],
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
    // No push: this suite is not about it, and the two seams it needs are a
    // cryptographic mint and a POST to somebody else's service.
    push: null,
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

/** One tool's structured answer, parsed rather than asserted into shape. */
async function structuredOf(
  connected: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await connected.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

/** What `list_servers` answered with, as a list of rows. */
async function serversOf(connected: Client): Promise<Record<string, unknown>[]> {
  return z
    .array(z.record(z.string(), z.unknown()))
    .parse((await structuredOf(connected, 'list_servers')).servers);
}

/**
 * Spins until something the hub is doing on its own has happened.
 *
 * The dial is started before the port is open and is deliberately not awaited
 * -- a machine that is switched off must not delay a hub coming up -- so its
 * failure lands a turn or two after this suite has a client.
 */
async function until(attempt: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await attempt()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
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

    expect(connected.getServerVersion()).toEqual({
      name: 'agentplex-hub',
      version: `client ${String(CLIENT_PROTOCOL_VERSION)} server ${String(SERVER_PROTOCOL_VERSION)}`,
    });
    // The same port, which is the whole claim. The PWA is on it too.
    expect((await fetch(`http://${HOST}:${String(started.port)}/`)).status).toBe(200);
  });

  it('lists the tools this build has', async () => {
    const started = await startTestHub();
    const connected = await connect(started);

    const { tools } = await connected.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'doc_create',
      'doc_list',
      'doc_read',
      'doc_update',
      'hub_info',
      'list_projects',
      'list_servers',
      'list_sessions',
      'read_terminal',
      'send_input',
      'session_status',
      'start_session',
      'stop_session',
    ]);
    // The split a client reads before it decides whether to ask a person: eight
    // that only read, five that act, and exactly one of those that destroys.
    // Making and saving a document are acts and neither is destructive -- the
    // document is there afterwards either way -- so the stop stays alone.
    const readers = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
    expect(readers.map((tool) => tool.name).sort()).toEqual([
      'doc_list',
      'doc_read',
      'hub_info',
      'list_projects',
      'list_servers',
      'list_sessions',
      'read_terminal',
      'session_status',
    ]);
    expect(tools.filter((tool) => tool.annotations?.destructiveHint === true)).toHaveLength(1);
    // And no tool takes a command, an argv, an environment or a directory, on
    // this build or any later one. The rule is the endpoint's whole claim, and
    // this is the listing a model is actually handed.
    //
    // It holds with a start that can now say where it runs, which is the point
    // of saying where by node id: `list_projects` shows a directory so a person
    // can tell two checkouts apart, and there is still nowhere on any input
    // schema to hand one back.
    const named = JSON.stringify(tools.map((tool) => tool.inputSchema));
    for (const forbidden of ['command', 'argv', 'args', 'env', 'cwd', 'directory', 'path']) {
      expect(named).not.toContain(`"${forbidden}"`);
    }
  });

  it('refuses a start on a fleet nobody can reach, in the fleet own words', async () => {
    // The act tools mounted, over a real port, answering out of the same
    // routing a client frame reaches. Nothing here is reachable, so what an
    // agent gets is a sentence about the store rather than a session that never
    // appears.
    const started = await startTestHub();
    const connected = await connect(started);

    const refused = await connected.callTool({
      name: 'start_session',
      arguments: { storeId: 'store-work', provider: 'claude' },
    });

    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect((refused.content as { text: string }[])[0]?.text).toBe(
      'no server the hub is paired with has that store mounted',
    );
  });

  it('answers hub_info with its id and the version of each leg it speaks', async () => {
    // The bar for every tool: nothing here is a capability the UI lacks. The id
    // and the client leg are in the `welcome` frame an attached client is sent
    // before it has asked for anything; the server leg is the number the web
    // build judges a discovered machine against, which the install checks hold
    // equal to the hub's.
    const started = await startTestHub();
    const connected = await connect(started);

    const result = await connected.callTool({ name: 'hub_info', arguments: {} });

    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({
      hubId: HUB_ID,
      clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
      serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    });
  });

  it('lists the fleet over the transport an agent actually speaks', async () => {
    // The tool that makes the endpoint worth having, end to end: a real port, a
    // real MCP client, the hub's own reducer behind it, and the pairing this
    // harness put in the table. The machine is unreachable on purpose -- what
    // has to be right is that its row survives that with the reason attached.
    const started = await startTestHub();
    const connected = await connect(started);
    await until(
      async () => (await serversOf(connected))[0]?.phase === 'stale',
      'the dial to attic to fail',
    );

    const servers = await serversOf(connected);

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      registrationId: 'registration-attic',
      label: 'attic',
      phase: 'stale',
      staleReason: 'unreachable',
      problem: 'connection refused',
    });
    // Nothing the hub dials with. The address is in the row this suite wrote
    // into the table, and it does not come back out here.
    expect(JSON.stringify(servers)).not.toContain('attic.example');
  });

  it('answers list_sessions with an empty list rather than a failure', async () => {
    // No machine is reachable, so there is nothing to report and that is an
    // answer. A tool that treated "nothing to say" as an error would make every
    // caller special-case a fleet that is merely asleep.
    const started = await startTestHub();
    const connected = await connect(started);

    const answered = await structuredOf(connected, 'list_sessions');

    expect(answered).toEqual({ sessions: [], matched: 0, omitted: 0 });
  });

  it('refuses a session nobody reports, in a sentence and not a stack trace', async () => {
    const started = await startTestHub();
    const connected = await connect(started);

    const status = await connected.callTool({
      name: 'session_status',
      arguments: { storeId: 'store-work', sessionId: 'session-quiet' },
    });
    const output = await connected.callTool({
      name: 'read_terminal',
      arguments: { storeId: 'store-work', sessionId: 'session-quiet' },
    });

    for (const refused of [status, output]) {
      expect(refused.isError).toBe(true);
      const content = refused.content as { type: string; text: string }[];
      expect(content[0]?.text).not.toContain('Error:');
      expect(content[0]?.text.length).toBeGreaterThan(10);
    }
    // The relay's own words for a terminal that is not there, carried whole
    // rather than reworded here. What an agent can act on is that no machine
    // with that volume is reachable, which this hub is the only thing that
    // knows.
    const words = (output.content as { text: string }[])[0]?.text ?? '';
    expect(words).toBe('no server the hub is paired with has that store mounted');
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
      expect((await first.listTools()).tools).toEqual((await second.listTools()).tools);

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
      state: emptyFleet,
      terminal: noTerminal,
      sessions: noSessions,
      docs: noDocs,
      projects: noProjects,
      timers: createFakeTimers(),
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
      state: emptyFleet,
      terminal: noTerminal,
      sessions: noSessions,
      docs: noDocs,
      projects: noProjects,
      timers: createFakeTimers(),
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
