import { z } from 'zod';
import type { NodeId } from '@agentplex/protocol';
import type { DocListed, DocOpened } from '../docs/docs.js';
import { parsedDocName, parsedNodeId, refusedDoc } from './doc-args.js';
import { answers, defineMcpTool, readOnly, refuses, type McpTool } from './tool-registry.js';

/**
 * A document, whole, from the machine that holds it.
 *
 * There is no range and no byte bound, because the hub has no copy to serve
 * part of: the whole file comes back from the machine that wrote it, or a
 * refusal naming that machine does. That is the cost of content never being
 * in the hub's database, taken deliberately -- an index the hub can list while
 * a laptop is shut, and content only the machine with the file can answer for.
 * `doc_list` is what an agent reads when this refuses; `reachable` on every
 * row there predicts exactly this refusal.
 *
 * ## Two ways to name one document, and why both
 *
 * By `docId`, which is what `doc_list` and `doc_create` hand back and what
 * every later call should use. Or by `projectId` and `name` together, which is
 * how a person says it -- "the plan in the agentplex project" -- and how an
 * agent that was told about a document in prose can find it without a listing
 * call first.
 *
 * The second form resolves through the same index the listing reads, and it
 * refuses rather than choosing when the name is not one document. A project's
 * documents are per machine -- the file store is under each server's own data
 * root -- so `plan.md` in one project can be two files on two machines, and a
 * tool that picked one of them would be answering a question the caller did
 * not ask. The refusal names the machines and asks for a `docId`, which is the
 * address that cannot be ambiguous.
 *
 * The two forms are not mixed. A call carrying `docId` and a name as well is
 * refused rather than having one of them quietly win: an agent that sent both
 * believes something about this tool, and being told which address to use is
 * worth more than an answer to the half of the call that happened to be read.
 */

/** What this tool needs of the docs feature: the read, and the index it resolves a name through. */
export interface DocReads {
  open(nodeId: NodeId): Promise<DocOpened>;
  list(projectId: NodeId): Promise<DocListed>;
}

/** What a caller is told when it named a document with neither address whole. */
const NO_ADDRESS =
  'name a document by docId, or by projectId and name together: doc_list gives both';

/** What a caller is told when it named one with both. */
const TWO_ADDRESSES =
  'name a document by docId or by projectId and name, not by both: a docId is the whole address';

export function docReadTool({ docs }: { readonly docs: DocReads }): McpTool {
  return defineMcpTool({
    name: 'doc_read',
    description:
      'Reads a project document back, whole, from the machine that holds it. Name it by docId, or by projectId and name. A document on a machine the hub cannot reach refuses: the hub keeps no copy of the content.',
    input: {
      docId: z
        .string()
        .optional()
        .describe('The node id of the document, as doc_list and doc_create report it.'),
      projectId: z
        .string()
        .optional()
        .describe('The project the document is in. Give it with name, instead of docId.'),
      name: z
        .string()
        .optional()
        .describe('What the document is called, such as plan.md. Give it with projectId.'),
    },
    output: {
      docId: z.string().describe('The node id of the document that was read.'),
      content: z.string().describe('The whole document, exactly as the file holds it.'),
      updatedAt: z
        .int()
        .describe(
          "When the machine holding it last wrote it, in milliseconds since the epoch on that machine's clock. It may be newer than the last doc_list said: a person or an agent can edit the file where it lives.",
        ),
    },
    annotations: readOnly,
    run: async ({ docId, projectId, name }) => {
      const byName = projectId !== undefined || name !== undefined;
      if (docId !== undefined && byName) return refuses(TWO_ADDRESSES);

      const found =
        docId === undefined ? await resolved(docs, projectId, name) : parsedNodeId(docId);
      if (!found.ok) return found;

      const opened = await docs.open(found.value);
      if (!opened.ok) return refusedDoc(opened);

      return answers({ docId: found.value, content: opened.content, updatedAt: opened.updatedAt });
    },
  });
}

/**
 * The node a project and a name come to, or the sentence saying why none.
 *
 * A read of the index and not of a machine, which is what keeps this form as
 * cheap as the other: resolving a name asks the hub what it already knows, and
 * the one thing that crosses to another machine is the open below.
 */
async function resolved(
  docs: DocReads,
  projectId: string | undefined,
  name: string | undefined,
): Promise<{ ok: true; value: NodeId } | { ok: false; problem: string }> {
  if (projectId === undefined || name === undefined) return refuses(NO_ADDRESS);

  const project = parsedNodeId(projectId);
  if (!project.ok) return project;
  const wanted = parsedDocName(name);
  if (!wanted.ok) return wanted;

  const listed = await docs.list(project.value);
  if (!listed.ok) return refusedDoc(listed);

  const matching = listed.docs.filter((doc) => doc.name === wanted.value);
  const only = matching[0];
  if (only === undefined) {
    return refuses(`that project has no document called ${name}; doc_list says what it has`);
  }
  if (matching.length > 1) {
    // Named rather than picked. Two machines each holding a `plan.md` in one
    // project is the ordinary shape of this store, not a corruption, and the
    // caller is the only party that knows which of them it meant.
    const machines = matching.map((doc) => doc.label).join(', ');
    return refuses(
      `${String(matching.length)} machines in that project have a document called ${name} ` +
        `(${machines}): name it by docId, which doc_list gives`,
    );
  }
  return { ok: true, value: only.nodeId };
}
