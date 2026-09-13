import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { sendJson, type Logger } from '@agentplex/node-shared';
import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { NOT_AUTHORIZED } from '../client-auth/client-auth.js';
import { hubInfoTool } from './hub-info.js';
import { admitsMcpRequest } from './mcp-auth.js';
import { registerTool, type McpTool } from './tool-registry.js';

/**
 * The MCP endpoint: streamable HTTP, on the hub's one port, behind the client
 * token.
 *
 * Same origin as the PWA and the client socket, and that is the whole point of
 * the hub serving the client at all -- `features/web/web.ts` carries that
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
 * The version is the wire contract this hub speaks and not the package it was
 * built from. The package's version is a fact nothing in this process currently
 * has -- it would take a seam through `main.ts` to learn one -- and the number
 * that actually decides whether this hub and a peer can talk is this one.
 * `serverInfo` is a display string either way: a caller that wants these facts
 * to compare rather than to print asks `hub_info`, where each of them is in a
 * field that says what it is.
 */
const SERVER_INFO = { name: 'agentplex-hub', version: String(PROTOCOL_VERSION) };

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

export function createMcp({ hubId, clientToken, logger }: McpDependencies): Mcp {
  /**
   * Every tool this build has. A later ticket adds a line: AGX-43 the read
   * tools, AGX-44 the acting ones, AGX-244 after them. Built once and
   * registered onto each request's server, because the list is a fact about the
   * build and the server is a fact about the request.
   */
  const tools: readonly McpTool[] = [hubInfoTool({ hubId })];

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
