import { providerSchema, type NodeId, type ServerRegistrationId } from '@agentplex/protocol';
import { z } from 'zod';
import type { StartOutcome, StartSessionRequest } from '../sessions/sessions.js';
import { parsedNodeId } from './node-args.js';
import { parsedServerId, parsedStoreId, refusedSession } from './session-args.js';
import { acts, answers, defineMcpTool, type McpTool } from './tool-registry.js';

/**
 * Starts a coding agent in a store, through the same feature the start button
 * does.
 *
 * ## What this tool cannot say, which is the point of it
 *
 * There is no operation name here, no argv element, no environment variable and
 * nowhere to put a working directory -- the same shape `session-start` has on
 * the wire, for the same reason. The server turns a store id into a directory
 * it resolved from its own configuration and a provider name into the adapter
 * that builds the argv, `shell: false`. A tool that took a command would be
 * this hub growing a shell the screen a person is looking at does not have,
 * which is the one thing the MCP endpoint promises never to do.
 *
 * `prompt` is the exception that proves it and it is user content rather than
 * an option: the adapter places it as one argv element and no shell ever sees
 * it. It is the same field the new-session form has.
 *
 * ## Where a session runs
 *
 * In the store, on the machine, and in a project -- and none of those three is
 * a directory this tool names. `projectId` is a node this hub already holds,
 * listed by `list_projects`, and it is the same argument the new-session form
 * sends: the hub reads the directory out of its own rows, the machine refuses
 * it unless its real path sits under a root that machine's own operator
 * configured, and what a person browsed is the only way a path got into those
 * rows in the first place. Three parties, and the value is checked by two of
 * them.
 *
 * An id and never a path, which is the whole shape of the argument rather than
 * a preference about spelling. A `directory` here would be an agent choosing
 * where a process runs, and no amount of validation downstream makes that a
 * different capability: the browse roots bound the damage, they do not remove
 * the choice. A node id can only ever name a directory somebody already
 * decided this hub may spawn in.
 *
 * Omitted, it is the store's own directory -- the behaviour this tool shipped
 * with, and what a caller that has no project in mind still gets.
 *
 * ## What it does not take either
 *
 * A session id. This starts a new session, and a new session has no id to name:
 * the provider mints its own and writes it, which is why the answer below
 * carries `null` and a start id instead. Resuming an existing session is the
 * same instruction with an id on it, and it is not here because nothing has
 * asked for it -- an agent that finds an idle session in `list_sessions` is
 * looking at a transcript it can read, and waking somebody else's is a decision
 * with a person in it.
 */

export interface SessionStarts {
  start(request: StartSessionRequest): Promise<StartOutcome>;
}

export function startSessionTool({ sessions }: { readonly sessions: SessionStarts }): McpTool {
  return defineMcpTool({
    name: 'start_session',
    description:
      'Starts a new coding-agent session in a store, optionally in one of the hub projects. The hub picks the least-loaded machine that can run the provider unless one is named.',
    input: {
      storeId: z
        .string()
        .describe('The store to start it in, as list_servers reports on each machine.'),
      provider: providerSchema.describe(
        'Which coding agent to run. The machine it lands on has to report that provider ready.',
      ),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The first thing to say to the agent. It is placed as one argument by the provider adapter and never goes through a shell. Omit it to leave the agent at its own prompt.',
        ),
      server: z
        .string()
        .optional()
        .describe(
          'A machine registration id from list_servers, overriding the hub scheduling. Omit it unless the work has to happen on one particular machine.',
        ),
      projectId: z
        .string()
        .optional()
        .describe(
          "A project node id from list_projects, to run the agent in that project rather than in the store's own folder. The hub works out where that is and the machine refuses it unless its operator allows work there. Omit it for the store's own folder.",
        ),
    },
    output: {
      storeId: z.string(),
      sessionId: z
        .string()
        .nullable()
        .describe(
          'Always null for a new session: the provider mints its own id and writes it afterwards, and list_sessions names it once the machine has scanned the store.',
        ),
      server: z.string().describe('The registration id of the machine it was started on.'),
      startId: z
        .string()
        .describe(
          "The hub's own name for this start. It is what this hub's logs and the machine's reports call the session until the provider has named it.",
        ),
    },
    annotations: acts,
    run: async ({ storeId, provider, prompt, server, projectId }) => {
      const store = parsedStoreId(storeId);
      if (!store.ok) return store;

      // Widened in a block rather than in an expression: an optional argument
      // that has to be parsed is two answers, and the one that refuses returns.
      let chosen: ServerRegistrationId | null = null;
      if (server !== undefined) {
        const parsed = parsedServerId(server);
        if (!parsed.ok) return parsed;
        chosen = parsed.value;
      }

      let project: NodeId | null = null;
      if (projectId !== undefined) {
        const parsed = parsedNodeId(projectId);
        if (!parsed.ok) return parsed;
        project = parsed.value;
      }

      const outcome = await sessions.start({
        storeId: store.value,
        sessionId: null,
        provider,
        // `undefined` and `null` are the same fact and the feature takes one of
        // them. An MCP argument that was not supplied is absent; a prompt that
        // was not given is `null` on the frame.
        prompt: prompt ?? null,
        server: chosen,
        // A node id or nothing, and the feature does the rest: a project this
        // hub has no row for, and a directory no machine will open, are both
        // refusals in words that come back as the sentence below. Neither is
        // decided here, because neither is a fact this file holds.
        project,
      });

      if (!outcome.ok) return refusedSession(outcome);

      return answers({
        storeId: outcome.storeId,
        sessionId: outcome.sessionId,
        server: outcome.server,
        startId: outcome.startId,
      });
    },
  });
}
