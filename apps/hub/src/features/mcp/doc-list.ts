import { z } from 'zod';
import type { DocListed, DocSummary } from '../docs/docs.js';
import type { NodeId } from '@agentplex/protocol';
import { refusedDoc } from './doc-args.js';
import { parsedNodeId } from './node-args.js';
import { answers, defineMcpTool, readOnly, type McpTool } from './tool-registry.js';

/**
 * What documents a project has, out of the hub's own index.
 *
 * The one document tool that asks no machine anything, and the asymmetry is
 * the whole reason the hub keeps an index at all: content lives on the machine
 * that wrote it and a listing does not, so an agent can see what a project
 * holds while the laptop holding it is shut. `docs.ts` carries that argument.
 *
 * What it costs is that a row is a claim about the last time the hub heard,
 * and the rows say so rather than pretending otherwise. `server` and `label`
 * name the machine -- a project's documents are not all on one, because the
 * file store is under each server's own data root -- and `reachable` says
 * whether reading that one will work right now. An agent that reads
 * `reachable: false` and calls `doc_read` anyway gets the refusal the flag
 * predicted, with the machine named in it; nothing here serves a stale copy,
 * because the hub has none to serve.
 *
 * Unbounded, alone among the listing tools, and for the reason `list_servers`
 * is: a project's documents are files a person made by hand. If that stops
 * being true it is `list_sessions` this should borrow a limit from.
 */

/** What this tool needs of the docs feature: the index, and nothing else. */
export interface DocIndex {
  list(projectId: NodeId): Promise<DocListed>;
}

/** One document in a project, as `doc_list` answers. */
export const docShape = {
  docId: z
    .string()
    .describe('The node id of this document. What doc_read and doc_update name it by.'),
  name: z.string().describe('What the file is called in the project folder.'),
  server: z
    .string()
    .describe(
      'The registration id of the machine holding the file. A project may have documents on more than one.',
    ),
  label: z.string().describe('What the person who paired that machine called it.'),
  reachable: z
    .boolean()
    .describe(
      'Whether the hub can reach that machine right now. False means doc_read will refuse: the hub holds no copy of the content.',
    ),
  updatedAt: z
    .int()
    .describe(
      "When the machine holding it last wrote it, in milliseconds since the epoch on that machine's clock.",
    ),
};

export type DocRow = z.infer<z.ZodObject<typeof docShape>>;

/**
 * One row, projected rather than cast.
 *
 * An explicit return type for the reason `fleet-view.ts` gives for every
 * projection in it: a field added to `DocSummary` is a field somebody decides
 * whether an agent should see, here, rather than one that appears in an
 * agent's context because a feature grew it.
 */
function toDocRow(summary: DocSummary): DocRow {
  return {
    docId: summary.nodeId,
    name: summary.name,
    server: summary.server,
    label: summary.label,
    reachable: summary.reachable,
    updatedAt: summary.updatedAt,
  };
}

export function docListTool({ docs }: { readonly docs: DocIndex }): McpTool {
  return defineMcpTool({
    name: 'doc_list',
    description:
      'Lists the documents in a project: what each is called, which machine holds it, and whether that machine can be reached right now. Read out of the hub index, so it answers while a machine is away.',
    input: {
      projectId: z
        .string()
        .describe('The node id of the project, as the hub tree and doc_create report it.'),
    },
    output: {
      docs: z.array(z.object(docShape)),
    },
    annotations: readOnly,
    run: async ({ projectId }) => {
      const project = parsedNodeId(projectId);
      if (!project.ok) return project;

      const listed = await docs.list(project.value);
      if (!listed.ok) return refusedDoc(listed);

      return answers({ docs: listed.docs.map(toDocRow) });
    },
  });
}
