import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { sendJson, type Logger, type Timers } from '@agentplex/node-shared';
import { CLIENT_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { NOT_AUTHORIZED } from '../client-auth/client-auth.js';
import { docCreateTool, type DocCreates } from './doc-create.js';
import { docListTool, type DocIndex } from './doc-list.js';
import { docReadTool, type DocReads } from './doc-read.js';
import { docUpdateTool, type DocSaves } from './doc-update.js';
import type { FleetReads } from './fleet-view.js';
import { hubInfoTool } from './hub-info.js';
import { listProjectsTool, type ProjectIndex } from './list-projects.js';
import { listServersTool } from './list-servers.js';
import { listSessionsTool } from './list-sessions.js';
import { admitsMcpRequest } from './mcp-auth.js';
import { readTerminalTool, type TerminalReads } from './read-terminal.js';
import { sendInputTool, type TerminalWrites } from './send-input.js';
import { sessionStatusTool } from './session-status.js';
import { startSessionTool, type SessionStarts } from './start-session.js';
import { stopSessionTool, type SessionStops } from './stop-session.js';
import { registerTool, type McpTool } from './tool-registry.js';

/**
 * The MCP endpoint: streamable HTTP, on the hub's one port, behind the client
 * token.
 *
 * Same origin as the PWA and the client socket, and that is the whole point of
 * the hub serving the client at all -- `web/web.ts` carries that
 * argument. An agent driving this hub and a person looking at it are behind one
 * port, one certificate and one credential, so "MCP gains no capability the UI
 * lacks" is a statement about one thing rather than a promise to keep two in
 * step. No CORS headers are added here: a caller from another origin is a caller
 * this endpoint has no reason to have.
 *
 * **Stateless.** No `sessionIdGenerator` is supplied, so no `Mcp-Session-Id` is
 * minted, none is validated, and every POST is served by an `McpServer` and a
 * transport built for it and closed with it. Sessions were the alternative and
 * they buy exactly two things: server-initiated notifications over a standalone
 * SSE stream, and resumption after a dropped connection. This endpoint has
 * neither to offer -- every tool is a request and an answer, nothing here
 * subscribes, and nothing is streamed -- and the cost is a table of live
 * transports keyed by a header, each one held until a client sends a DELETE it
 * is under no obligation to send. A hub that leaked a transport per abandoned
 * agent, and a second id that looks enough like a credential to end up in a log,
 * is a real price for a capability that does not exist. When a tool needs to
 * push -- a session's output, say -- that is the ticket that argues for sessions,
 * and it will have something to weigh.
 *
 * **POST only.** In stateless mode a GET is still a request to open the
 * standalone notification stream, and the transport would answer it with an SSE
 * response that never ends: a per-request transport would then be held open for
 * as long as the agent lived, which is the leak statelessness was chosen to
 * avoid. GET and DELETE get a 405, which the specification explicitly permits
 * for a server that offers no stream and keeps no session, and which the SDK's
 * own client is written to expect -- it opens the stream after `initialize` and
 * treats a 405 as "there is no stream here" rather than an error.
 *
 * **JSON, not SSE, for the answer.** `enableJsonResponse` makes a POST an
 * ordinary request and response. The alternative is a one-message event stream
 * with a keep-alive timer behind it, which is the same bytes plus a framing and
 * a timer for a reply that was already complete when it was sent.
 */

/** Where an MCP client speaks to this hub. Named here; routed in `http/routes.ts`. */
export const MCP_PATH = '/mcp';

/** What a caller is told when it used a verb this endpoint does not answer. */
const NOT_A_POST = `${MCP_PATH} takes a POST`;

/**
 * What a caller is told once this hub has started shutting down. 503 rather
 * than 500: nothing is broken, and an agent that retries in a moment will find
 * either this hub back or nothing at all listening, both of which are honest.
 */
const STOPPING = 'the hub is stopping';

/**
 * How this hub names itself in the answer to `initialize`.
 *
 * The version is the pair of wire contracts this hub speaks, one per leg, and
 * not the package it was built from. The package's version is a fact nothing in
 * this process currently has -- it would take a seam through `main.ts` to learn
 * one -- and the numbers that actually decide whether this hub and a peer can
 * talk are these.
 * `serverInfo` is a display string either way: a caller that wants these facts
 * to compare rather than to print asks `hub_info`, where each of them is in a
 * field that says what it is.
 */
const SERVER_INFO = {
  name: 'agentplex-hub',
  version: `client ${String(CLIENT_PROTOCOL_VERSION)} server ${String(SERVER_PROTOCOL_VERSION)}`,
};

/**
 * The SDK's own transport, as the SDK's own `Transport`.
 *
 * They are not the same type here, and the difference is entirely this
 * repository's `exactOptionalPropertyTypes`: the interface declares
 * `onclose?: () => void` where the class declares `onclose: (() => void) |
 * undefined`, which that flag treats as two different things and every runtime
 * treats as one. The flag earns its keep elsewhere -- it is what stops an
 * optional field being written as `undefined` and read back as present -- so
 * the mismatch is absorbed in this one line rather than by loosening it for the
 * whole app. Nothing is being claimed about a value here: both sides of the
 * assertion are declarations shipped in the same package.
 */
function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return transport as Transport;
}

export interface McpDependencies {
  /** One of the two facts `hub_info` answers with. The other is a constant. */
  readonly hubId: HubId;
  /**
   * The same credential the client exchanges for a socket ticket. It arrives
   * from configuration, it is never minted here, and it never leaves
   * `mcp-auth.ts`.
   */
  readonly clientToken: string;
  /**
   * What the hub believes about its fleet, as it publishes it to a client.
   *
   * The published projection and not the reducer's own state, which is the
   * line this endpoint's whole claim rests on: a tool reads exactly what an
   * attached browser is broadcast, so "MCP gains no capability the UI lacks" is
   * something this file can point at rather than something it asserts.
   */
  readonly state: FleetReads;
  /**
   * The terminal relay, narrowed to what these tools do with one: subscribe,
   * type, and give the client back.
   *
   * Widened by exactly one method since the read tools, which is what AGX-43
   * asked of this ticket: `send_input` needs `input` and nothing else needed
   * anything. There is still no path from a tool to `resize` -- a screen size
   * is a fact about a viewer and an agent is not one -- nor to `deliver`,
   * `noteStart` or `noteStarts`, which are the relay's own wiring to the
   * servers feature.
   */
  readonly terminal: TerminalReads & TerminalWrites;
  /**
   * Starting and stopping, narrowed to the two methods the feature has anyway.
   *
   * Declared as what the tools use rather than taken as `Sessions`, so that a
   * method added to that feature is not a capability this endpoint silently
   * acquires. Both go through the same routing a client's own frame does: the
   * hub picks the machine, refuses a session that is already running and names
   * the holder, and resolves a stop's owner hub-side.
   */
  readonly sessions: SessionStarts & SessionStops;
  /**
   * Documents: the docs feature's four functions, and nothing else.
   *
   * The whole of that feature's surface, which is the one place this endpoint
   * takes everything a feature has rather than a narrowing of it -- and it is
   * still the same argument. `docs.ts` exists to be the one write path a
   * document takes, with the client connection and these tools as its two
   * callers; a tool that reached a server itself would be a second answer to
   * what a document write means. So the four functions are what MCP gets, and
   * what it is denied is everything below them: no connection, no instruction,
   * no row, and nowhere to put a path.
   */
  readonly docs: DocIndex & DocReads & DocCreates & DocSaves;
  /**
   * Projects, narrowed to the listing and nothing else.
   *
   * One method of a feature with seven, and the six it is denied are the
   * point. `create` would let an agent add a row that names a directory, which
   * is the one way a path could reach this hub from outside a browse;
   * `directoryOf`, `directories` and the two `findBy` lookups are how a node
   * and a path become each other, and the only callers that may make that
   * turn are the sessions feature, on its way to the machine that will check
   * it again, and the tree placing what a server reported. `listDirectory` is the browse, and
   * an agent that could list a disk is the capability this endpoint exists not
   * to have.
   *
   * A start in a project therefore goes the same way a client's frame does:
   * the tool passes a node id to `sessions.start`, and that feature -- not
   * this one -- reads the row.
   */
  readonly projects: ProjectIndex;
  /** The deadline a terminal read gives up after. */
  readonly timers: Timers;
  readonly logger: Logger;
}

export interface Mcp {
  /**
   * Answers one request on `MCP_PATH`, refusal included.
   *
   * It takes the request and the response rather than returning a value, which
   * is the one place in this hub's routing that a feature writes to a socket.
   * The reason is the transport: streamable HTTP is a body shape the SDK owns,
   * and a seam that returned bytes would mean re-implementing it here in order
   * to keep a rule about who writes responses. Everything this file itself
   * decides -- the bearer gate, the verb, the shutdown -- is a value first, in
   * `mcp-auth.ts` and in the constants above.
   */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /**
   * Refuses further requests and closes whatever is still in flight.
   *
   * Meaningful even with no sessions to end: a POST being served when the hub
   * is asked to stop has an `McpServer` and a transport behind it, and closing
   * the HTTP listener does not reach either.
   */
  close(): Promise<void>;
}

export function createMcp({
  hubId,
  clientToken,
  state,
  terminal,
  sessions,
  docs,
  projects,
  timers,
  logger,
}: McpDependencies): Mcp {
  /**
   * Every tool this build has. Built once and registered onto each request's
   * server, because the list is a fact about the build and the server is a fact
   * about the request.
   *
   * Eight that read and five that act, and the split is in the annotations
   * rather than in this list: each of the five says `readOnlyHint: false`, and
   * the stop alone says `destructiveHint: true`, which is what a client reads
   * before deciding whether to ask a person first.
   *
   * ## `list_projects` is the half of `start_session` that names a place
   *
   * A start may name the project it runs in, by node id, and an id is no use
   * to a caller that cannot find out which ids exist. The two are one
   * capability and they are listed apart only because one reads and one acts.
   * Neither of them says a directory: the listing shows one so a person can
   * tell two checkouts apart, and there is no input property on this endpoint
   * that would take one back.
   *
   * ## The document tools call a feature, like every other tool here
   *
   * `doc_list`, `doc_read`, `doc_create` and `doc_update` are the docs
   * feature's four functions with schemas and sentences on them. They reach no
   * server and hold no row: the index, the refusals and the one write path are
   * that feature's, and these four are the same callers the client connection
   * is. Which is why they can gain no capability the UI lacks -- the UI's own
   * frames land on the same four functions.
   *
   * ## There is no `answer_permission`, and that is a finding rather than an
   * omission
   *
   * AGX-44 names one. This build has nothing honest to put behind it: there is
   * no permission frame on either leg of the protocol, no field on any frame
   * that carries an approval, and nothing in `@agentplex/providers` that maps
   * "allow" or "deny" onto anything a provider understands -- the adapters
   * derive `awaiting-permission` as a *status* and stop there. A tool that
   * typed a guessed keystroke at a prompt it could not see would be answering
   * on a user's behalf without being able to say what it had agreed to, which
   * is the one thing an approval must never be. Approvals are epic AGX-104 and
   * the frame that carries one is theirs to design.
   *
   * What is here in the meantime is the truth rather than a stand-in: a
   * terminal prompt is answered by typing, `send_input` types, and an agent
   * that knows what a provider is asking can answer it exactly as a person at
   * the keyboard would -- with the same and only the same information.
   */
  const tools: readonly McpTool[] = [
    hubInfoTool({ hubId }),
    listProjectsTool({ projects }),
    listServersTool({ state }),
    listSessionsTool({ state }),
    sessionStatusTool({ state }),
    readTerminalTool({ terminal, timers }),
    startSessionTool({ sessions }),
    sendInputTool({ terminal, logger }),
    stopSessionTool({ sessions }),
    docListTool({ docs }),
    docReadTool({ docs }),
    docCreateTool({ docs }),
    docUpdateTool({ docs }),
  ];

  /**
   * What is being served right now. Empty between requests, which is what
   * stateless means here; it is held only so that `close` has something to
   * close.
   */
  const inFlight = new Set<StreamableHTTPServerTransport>();
  let stopping = false;

  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      // Before the verb, and unlike the ticket exchange, which checks its
      // method first so that a client with a good credential is told about the
      // wrong verb. That argument does not reach here: it is about a GET to the
      // exchange being cacheable and linkable, and there is no reason to tell a
      // caller that could not authenticate anything at all about this endpoint
      // -- including which verbs it has.
      if (!admitsMcpRequest(request.headers.authorization, clientToken)) {
        // The path and the fact of the refusal, the same line the ticket
        // exchange logs. The credential is in a header this line does not read
        // and `admitsMcpRequest` does not return.
        logger.warn('client refused', { path: MCP_PATH });
        sendJson(response, 401, { error: NOT_AUTHORIZED });
        return;
      }

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: NOT_A_POST });
        return;
      }

      if (stopping) {
        sendJson(response, 503, { error: STOPPING });
        return;
      }

      const server = new McpServer(SERVER_INFO);
      for (const tool of tools) registerTool(server, tool);

      // `sessionIdGenerator` is absent rather than `undefined`, which is the
      // same instruction to the SDK and the only spelling this repository's
      // `exactOptionalPropertyTypes` allows. Its absence is what makes this
      // stateless; the argument for that is at the top of the file.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      inFlight.add(transport);

      try {
        await server.connect(asTransport(transport));
        await transport.handleRequest(request, response);
      } finally {
        // Both, always. `handleRequest` has written the whole answer by the time
        // it resolves -- there is no stream left open, which is what
        // `enableJsonResponse` bought -- and a transport left behind here would
        // be one per request rather than one per session.
        inFlight.delete(transport);
        await transport.close();
        await server.close();
      }
    },

    async close(): Promise<void> {
      stopping = true;
      // A copy, because closing a transport runs the `finally` above on
      // whatever was awaiting it, which mutates the set being read.
      await Promise.all([...inFlight].map((transport) => transport.close()));
      inFlight.clear();
    },
  };
}
