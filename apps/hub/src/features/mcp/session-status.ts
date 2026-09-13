import { z } from 'zod';
import { allSessions, sessionDetailShape, toSessionDetail, type FleetReads } from './fleet-view.js';
import { answers, defineMcpTool, readOnly, refuses, type McpTool } from './tool-registry.js';

/**
 * One session, whole.
 *
 * The same row `list_sessions` returns plus the two facts a listing has no room
 * for -- the uncommitted diffstat and the token count -- because this is the
 * question asked about one session rather than about a fleet, and one row is
 * worth the fields.
 *
 * A session is `{ storeId, sessionId }` and never a machine, which is why both
 * are required and why neither of them is a server. The same session may be
 * readable from two machines with one volume mounted, and the answer is the
 * same session either way; `holder` says which machine is running it, if any.
 *
 * A session this hub has never been told about is a refusal in words rather
 * than an empty answer. The two are different facts -- "no such session" and
 * "here is a session with nothing in it" -- and only one of them is true.
 */
export function sessionStatusTool({ state }: { readonly state: FleetReads }): McpTool {
  return defineMcpTool({
    name: 'session_status',
    description:
      'Reads everything this hub knows about one session: its status, where it is running, its working directory and branch, its uncommitted diffstat and what it has spent.',
    input: {
      storeId: z.string().describe('The store the session is filed under.'),
      sessionId: z.string().describe('The session id, as list_sessions returns it.'),
    },
    output: {
      session: z.object(sessionDetailShape),
    },
    annotations: readOnly,
    run: ({ storeId, sessionId }) => {
      const found = allSessions(state.published()).find(
        (row) => row.descriptor.storeId === storeId && row.descriptor.sessionId === sessionId,
      );
      if (found === undefined) {
        // Both halves of the identity, because either one of them can be the
        // wrong half and a sentence naming only the session id would leave a
        // caller guessing which.
        return refuses(
          `no session ${sessionId} in store ${storeId}; list_sessions says what this hub can see`,
        );
      }
      return answers({ session: toSessionDetail(found) });
    },
  });
}
