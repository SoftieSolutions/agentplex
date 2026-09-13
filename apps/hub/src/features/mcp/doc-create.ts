import { DOC_CONTENT_MAX_CHARS, type DocName, type NodeId } from '@agentplex/protocol';
import type { ServerRegistrationId } from '@agentplex/protocol';
import { z } from 'zod';
import type { DocCreated } from '../docs/docs.js';
import { parsedDocName, parsedNodeId, refusedDoc } from './doc-args.js';
import { parsedServerId } from './session-args.js';
import { acts, answers, defineMcpTool, type McpTool } from './tool-registry.js';

/**
 * Makes a document in a project, on one machine, with its first content.
 *
 * The same four arguments the client frame carries and in the same shape, for
 * the same reasons `client.ts` states them. `projectId` is a node id and never
 * a directory: the hub is the only party that turns one into a path, on the
 * machine that is about to write. `server` is named by the caller and is not
 * the hub's to choose -- unlike a session start, which names a store the hub
 * may run on any machine that has it mounted, a document is a file on one
 * machine's disk and there is no sense in which the hub could pick.
 *
 * It refuses where the docs feature refuses and in the feature's own words:
 * a project this hub does not have, a machine it is not connected to, and a
 * name that project already has on that machine. That last one is checked
 * before anything is written rather than after, and `docs.ts` says why -- a
 * write replaces a file whole, so a create that found the duplicate afterwards
 * would have already overwritten the document it is about to refuse over.
 *
 * ## Why it is not read-only, and not destructive either
 *
 * It makes a file that was not there and takes nothing away, which is exactly
 * what `acts` says. Not idempotent: a second call with the same name is
 * refused rather than silently taken as the first, and a client told otherwise
 * might retry a call it only thought had failed and read the refusal as the
 * document having gone.
 */

/** What this tool needs of the docs feature: the create, and nothing else. */
export interface DocCreates {
  create(
    projectId: NodeId,
    server: ServerRegistrationId,
    name: DocName,
    content: string,
  ): Promise<DocCreated>;
}

export function docCreateTool({ docs }: { readonly docs: DocCreates }): McpTool {
  return defineMcpTool({
    name: 'doc_create',
    description:
      'Makes a new document in a project on one machine, with its first content. Refuses a name the project already has on that machine: change it with doc_update instead.',
    input: {
      projectId: z
        .string()
        .describe('The node id of the project, as the hub tree and doc_list report it.'),
      server: z
        .string()
        .describe(
          'The registration id of the machine to write it on, from list_servers. A document is a file on one machine; the hub does not pick for you.',
        ),
      name: z
        .string()
        .describe(
          'What to call it, such as plan.md. One path segment of ASCII letters, digits, dots, hyphens and underscores, ending in .md, .txt, .json or .csv.',
        ),
      content: z
        .string()
        .max(DOC_CONTENT_MAX_CHARS)
        .describe(
          `The whole first version of the document. At most ${String(DOC_CONTENT_MAX_CHARS)} characters.`,
        ),
    },
    output: {
      docId: z
        .string()
        .describe('The node id of the new document. What doc_read and doc_update name it by.'),
    },
    annotations: acts,
    run: async ({ projectId, server, name, content }) => {
      // Every argument parsed before anything is asked of a machine, and in a
      // block rather than an expression: three of them can be the wrong one,
      // and the one that refuses returns.
      const project = parsedNodeId(projectId);
      if (!project.ok) return project;
      const machine = parsedServerId(server);
      if (!machine.ok) return machine;
      const called = parsedDocName(name);
      if (!called.ok) return called;

      const created = await docs.create(project.value, machine.value, called.value, content);
      if (!created.ok) return refusedDoc(created);

      return answers({ docId: created.nodeId });
    },
  });
}
