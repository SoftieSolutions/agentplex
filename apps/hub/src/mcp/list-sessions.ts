import {
  providerSchema,
  sessionStatusSchema,
  type Provider,
  type SessionRow,
  type SessionStatus,
} from '@agentplex/protocol';
import { z } from 'zod';
import { allSessions, sessionShape, toSessionRow, type FleetReads } from './fleet-view.js';
import { answers, defineMcpTool, readOnly, type McpTool } from './tool-registry.js';

/**
 * The sessions this hub can see, filtered and bounded.
 *
 * ## Where these rows come from, and where they will come from
 *
 * The fleet state, which is the hub's live merge of what every connected server
 * reports. AGX-240 is building the catalogue query -- `catalogue-query` and
 * `catalogue-page`, with grouping, sort keys and a cursor -- and when it lands
 * this tool moves onto it, because that is the query a client's own list view
 * runs and this tool has no business running a different one. It is not waited
 * for: the fleet state is what a client is broadcast today, so a projection of
 * it is a projection of what the UI has today, and moving the source later
 * changes this file and no schema above it.
 *
 * ## Why it is bounded, and why by recency
 *
 * A fleet with four machines and a month of work on each has more sessions than
 * a model should be made to read to answer "what is waiting on me". So there is
 * a limit with a stated default, and -- this is the part that matters -- what
 * the limit keeps is the most recently touched, not the first the reducer
 * happened to sort. A bounded list that cut off the newest rows would be a list
 * that answers the question backwards.
 *
 * What is cut is said rather than implied. `omitted` is how many matched the
 * filters and did not fit, so a caller can tell "there are only three" from
 * "here are the newest fifty of four hundred" without counting the array.
 */

/**
 * How many rows an unasked-for answer carries.
 *
 * Enough that a small fleet is answered whole and a model is never made to page
 * for a question it asked once; small enough that a bad filter costs a few
 * kilobytes rather than a context window.
 */
export const LIST_SESSIONS_DEFAULT_LIMIT = 50;

/** The most any one call may ask for, however large a number it names. */
export const LIST_SESSIONS_MAX_LIMIT = 500;

export function listSessionsTool({ state }: { readonly state: FleetReads }): McpTool {
  return defineMcpTool({
    name: 'list_sessions',
    description:
      'Lists the coding-agent sessions this hub can see, newest first, with the status and holder of each. Filter by machine, store, provider or status.',
    input: {
      server: z
        .string()
        .optional()
        .describe(
          'A machine registration id from list_servers. Keeps the sessions that machine reported.',
        ),
      store: z.string().optional().describe('A store id. Keeps the sessions filed under it.'),
      provider: providerSchema.optional().describe('Keeps the sessions of one coding agent.'),
      status: sessionStatusSchema
        .optional()
        .describe(
          'Keeps the sessions in one state. awaiting-permission is the one that wants a person.',
        ),
      limit: z
        .int()
        .min(1)
        .max(LIST_SESSIONS_MAX_LIMIT)
        .default(LIST_SESSIONS_DEFAULT_LIMIT)
        .describe(
          `How many rows to return, newest first. Defaults to ${String(LIST_SESSIONS_DEFAULT_LIMIT)}, at most ${String(LIST_SESSIONS_MAX_LIMIT)}.`,
        ),
    },
    output: {
      sessions: z.array(z.object(sessionShape)),
      matched: z.int().describe('How many sessions the filters kept, before the limit.'),
      omitted: z
        .int()
        .describe(
          'How many of those did not fit. Ask again with a tighter filter, not a larger limit.',
        ),
    },
    annotations: readOnly,
    run: ({ server, store, provider, status, limit }) => {
      const matched = allSessions(state.published())
        .filter((row) => keeps(row, { server, store, provider, status }))
        .sort(byRecency);

      return answers({
        sessions: matched.slice(0, limit).map(toSessionRow),
        matched: matched.length,
        omitted: Math.max(0, matched.length - limit),
      });
    },
  });
}

interface SessionFilters {
  readonly server: string | undefined;
  readonly store: string | undefined;
  readonly provider: Provider | undefined;
  readonly status: SessionStatus | undefined;
}

/**
 * Whether one row survives the filters.
 *
 * `server` is matched against `reportedBy` and not against the holder, and the
 * difference is a real one on a shared volume: two machines with the same disk
 * mounted both read the same transcripts, so "sessions on that machine" is
 * every session it can see. Which machine has the live process is a separate
 * question with a separate field, `holder`, on every row this returns.
 *
 * An unknown id is not an error. A filter that matches nothing is an empty list
 * with `matched: 0`, which is what a caller has to handle anyway -- a machine
 * that was unpaired between two calls is exactly that case, and refusing it
 * would make a race into a failure.
 */
function keeps(row: SessionRow, filters: SessionFilters): boolean {
  if (filters.server !== undefined && !row.reportedBy.some((id) => id === filters.server)) {
    return false;
  }
  if (filters.store !== undefined && row.descriptor.storeId !== filters.store) return false;
  if (filters.provider !== undefined && row.descriptor.provider !== filters.provider) return false;
  if (filters.status !== undefined && row.descriptor.status !== filters.status) return false;
  return true;
}

/**
 * Newest first, ties broken by session id.
 *
 * The tiebreak is not decoration: without it two sessions written in the same
 * millisecond could swap places between two calls, and a caller paging by
 * tightening a filter would see one twice and one never. Sort order is part of
 * a bounded answer.
 */
function byRecency(left: SessionRow, right: SessionRow): number {
  if (left.descriptor.updatedAt !== right.descriptor.updatedAt) {
    return right.descriptor.updatedAt - left.descriptor.updatedAt;
  }
  return left.descriptor.sessionId < right.descriptor.sessionId ? -1 : 1;
}
