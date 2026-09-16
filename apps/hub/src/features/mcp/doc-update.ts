import { DOC_CONTENT_MAX_CHARS, type NodeId } from '@agentplex/protocol';
import { z } from 'zod';
import type { DocSaved } from '../docs/docs.js';
import { parsedNodeId, refusedDoc } from './doc-args.js';
import { acts, answers, defineMcpTool, type McpTool } from './tool-registry.js';

/**
 * Replaces a document's content, whole.
 *
 * **There is no patch form and there will not be one**, which is the one thing
 * a caller has to know before it uses this: whatever `content` carries is what
 * the file becomes, so an agent that sends a fragment has deleted the rest of
 * the document. The description says so in those terms, because the model
 * reading it is the party that has to get this right and a hint in a schema
 * comment it never sees would not help it.
 *
 * The protocol is shaped that way on purpose and `client.ts` carries the
 * argument: the hub holds no copy of any document, so a patch would be the hub
 * applying a diff against a version it never saw whole, and a write that
 * half-applied would leave a file nobody can account for. `doc_read` returns
 * the whole document for exactly this reason -- read it, change it, send it
 * back.
 *
 * The node is the whole address. Which project, which machine and what the
 * file is called are the hub's own rows, and an argument restating any of them
 * would be an argument that could redirect a write.
 *
 * ## Why it is not read-only, not destructive, and not idempotent
 *
 * Not read-only: it writes a file. Not destructive: the document is still
 * there afterwards and still named the same thing -- this is a save, the same
 * act as a person pressing save in the editor beside it, and nothing a
 * `doc_read` before it could not have fetched is taken away. Removing a
 * document is not here at all; it is a node the catalogue removes, once
 * AGX-239 lands.
 *
 * Not idempotent, and that is the honest of the three rather than the obvious
 * one. Sending the same content twice leaves the same characters in the file,
 * but the second write moves the write time the machine records -- which is
 * what `doc_list` shows and what a person reads as "edited two minutes ago" --
 * so a client told this call had no additional effect would be told something
 * the listing contradicts.
 */

/** What this tool needs of the docs feature: the save, and nothing else. */
export interface DocSaves {
  save(nodeId: NodeId, content: string): Promise<DocSaved>;
}

export function docUpdateTool({ docs }: { readonly docs: DocSaves }): McpTool {
  return defineMcpTool({
    name: 'doc_update',
    description:
      'Replaces a document with the content given, whole. There is no patch form: send the entire document every time, because whatever this call carries is what the file becomes. Read it first with doc_read.',
    input: {
      docId: z
        .string()
        .describe('The node id of the document, as doc_list and doc_create report it.'),
      content: z
        .string()
        .max(DOC_CONTENT_MAX_CHARS)
        .describe(
          `The whole document as it should now read, not the part that changed. At most ${String(DOC_CONTENT_MAX_CHARS)} characters.`,
        ),
    },
    output: {
      docId: z.string().describe('The node id of the document that was written.'),
      updatedAt: z
        .int()
        .describe(
          "When the machine holding it recorded the write, in milliseconds since the epoch on that machine's clock. The hub carries the machine's time rather than its own receipt time.",
        ),
    },
    annotations: acts,
    run: async ({ docId, content }) => {
      const doc = parsedNodeId(docId);
      if (!doc.ok) return doc;

      const saved = await docs.save(doc.value, content);
      if (!saved.ok) return refusedDoc(saved);

      return answers({ docId: doc.value, updatedAt: saved.updatedAt });
    },
  });
}
