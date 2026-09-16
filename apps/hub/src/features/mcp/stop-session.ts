import { z } from 'zod';
import type { SessionOutcome, StopSessionRequest } from '../sessions/sessions.js';
import { parsedSessionRef, refusedSession } from './session-args.js';
import { answers, defineMcpTool, destroys, type McpTool } from './tool-registry.js';

/**
 * Stops the process running a session, through the same feature the stop button
 * does.
 *
 * It addresses `{ storeId, sessionId }` and nothing else, which is the whole of
 * "the stop resolves the owner hub-side": there is no machine argument, no
 * terminal handle and no pid, so the worst this tool can do is stop a session
 * it can already see in `list_sessions`. Which machine holds it is the hub's to
 * work out, and it is the only thing that can -- two machines sharing a volume
 * see the same transcripts and only one of them has the process.
 *
 * ## The two refusals worth reading
 *
 * A session nothing is running is refused rather than answered: "there was
 * nothing to stop" and "it is stopped now" are different facts and only one of
 * them is true. And a holder that is mid-turn is refused with the machine
 * named, because interrupting a turn between a tool call and the edit it was
 * about is how a half-applied change is left on disk. That is the same refusal
 * the button does not offer and the same sentence a browser is sent;
 * `session-routing.ts` carries the argument for both, and neither is re-decided
 * here.
 *
 * The transcript is untouched either way. Stopping ends a process, and what the
 * agent wrote stays where it wrote it.
 */

export interface SessionStops {
  stop(request: StopSessionRequest): Promise<SessionOutcome>;
}

export function stopSessionTool({ sessions }: { readonly sessions: SessionStops }): McpTool {
  return defineMcpTool({
    name: 'stop_session',
    description:
      'Stops the coding agent running a session. The hub resolves which machine holds it; a session mid-turn is refused rather than interrupted. The transcript is left alone.',
    input: {
      storeId: z.string().describe('The store the session is filed under.'),
      sessionId: z.string().describe('The session id, as list_sessions returns it.'),
    },
    output: {
      storeId: z.string(),
      sessionId: z.string(),
      server: z
        .string()
        .describe('The registration id of the machine that was holding it. Resolved by the hub.'),
    },
    annotations: destroys,
    run: async ({ storeId, sessionId }) => {
      const ref = parsedSessionRef(storeId, sessionId);
      if (!ref.ok) return ref;

      const outcome = await sessions.stop(ref.value);
      if (!outcome.ok) return refusedSession(outcome);

      return answers({
        storeId: outcome.storeId,
        // Not null on a stop, and never can be: a stop named a session, which
        // already had an id. The feature shares one answer type with a start,
        // whose spawn has none yet.
        sessionId: outcome.sessionId ?? sessionId,
        server: outcome.server,
      });
    },
  });
}
