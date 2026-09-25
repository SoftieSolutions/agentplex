import { PROTOCOL_VERSION } from '@agentplex/protocol';
import { sendBytes, sendJson, type Logger, type RequestHandler } from '@agentplex/node-shared';
import { requestPath, CLIENT_TICKET_PATH, type ClientAuth } from '../client-auth/client-auth.js';
import { MCP_PATH, type Mcp } from '../mcp/mcp.js';
import type { Web } from '../web/web.js';

/**
 * Everything this hub answers on its one port, in the order it answers it.
 *
 * Four routes and a chain, and the order is the only rule in the file that
 * matters. The hub's own endpoints are matched first, against literal paths;
 * the client the browser runs is served last, from whatever is left. That is
 * what lets the PWA, the authenticated socket and the hub's endpoints share an
 * origin without the origin becoming a place to negotiate: nothing that ends
 * up in the web root can take over a path the hub owns, however it is named.
 * `/mcp` is here for that reason and not only for tidiness: the MCP endpoint is
 * specified as same-origin with the UI, which is a claim about this port, and
 * it would stop being one the day a file called `mcp` in the web root could
 * answer to the name.
 *
 * One origin is a requirement rather than packaging convenience --
 * `web/web.ts` carries that argument -- and this is where it is kept.
 *
 * Everything routes on `requestPath` and never on `request.url`, because the
 * socket's URL carries a ticket and a raw request target is therefore a
 * secret. The normalized path is the form that is safe to log, and it is the
 * only form that appears in a line below.
 */

export interface HubRouteDependencies {
  /**
   * The ticket exchange. A seam rather than the token, so that this file holds
   * no credential and decides nothing about one: it turns an answer into HTTP.
   */
  readonly clientAuth: ClientAuth;
  /**
   * The MCP endpoint. The one route that writes its own response: streamable
   * HTTP is a body shape the SDK owns, and `mcp/mcp.ts` argues why
   * that is the seam rather than a value this file turns into HTTP.
   */
  readonly mcp: Mcp;
  /** The built client, as the feature that serves it. */
  readonly web: Web;
  readonly logger: Logger;
}

export function createHubRoutes({
  clientAuth,
  mcp,
  web,
  logger,
}: HubRouteDependencies): RequestHandler {
  return (request, response) => {
    const path = requestPath(request.url);

    if (path === '/health') {
      sendJson(response, 200, { status: 'ok', role: 'hub', protocolVersion: PROTOCOL_VERSION });
      return;
    }

    if (path === CLIENT_TICKET_PATH) {
      const answer = clientAuth.answerTicketRequest({
        method: request.method,
        authorization: request.headers.authorization,
      });
      // The path and the fact of the refusal. Which check failed is not
      // information this hub owes anyone -- see `client-auth.ts` -- and the
      // credential that failed it is in a header this line does not read.
      if (answer.status === 401) logger.warn('client refused', { path });
      sendJson(response, answer.status, answer.body);
      return;
    }

    if (path === MCP_PATH) {
      void mcp.handle(request, response).catch((error: unknown) => {
        // The transport writes its own refusals, so reaching here means the
        // request failed before or outside anything that could answer it. The
        // path is the normalized one and the body says nothing else: a caller
        // that did not authenticate has already been turned away above, and one
        // that did is owed a fault and not this hub's stack.
        logger.error('mcp request failed', { path, error: String(error) });
        if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
        else response.end();
      });
      return;
    }

    // Last, and only last.
    void web.answer({ method: request.method, path }).then(
      (answer) => sendBytes(response, answer),
      (error: unknown) => {
        // A read that failed for a reason that is not absence. The path is
        // safe to log -- it is the normalized one, with the query gone -- and
        // this is a fault rather than a missing file, so it says 500.
        logger.error('client asset unreadable', { path, error: String(error) });
        sendJson(response, 500, { error: 'internal' });
      },
    );
  };
}
