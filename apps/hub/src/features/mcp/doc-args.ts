import { docNameSchema, nodeIdSchema, DOC_NAME_EXTENSIONS } from '@agentplex/protocol';
import type { DocName, NodeId } from '@agentplex/protocol';
import type { DocRefusal } from '../docs/docs.js';
import { refuses, type McpAnswer } from './tool-registry.js';

/**
 * The two things every document tool does with words: turn what a model typed
 * into the values the docs feature takes, and turn that feature's no back into
 * a sentence.
 *
 * Here rather than in each of the four tools for the reason `session-args.ts`
 * gives: the wording is the contract. A node id spelled wrong is refused in
 * the same sentence whichever tool was called, so an agent can branch on the
 * answer instead of matching four phrasings of one fact.
 *
 * ## A node id, and never a path
 *
 * These tools name a project by node id and a document by node id or by name
 * in a project, and there is nowhere in any of them to put a directory. That
 * is not politeness about argument design: the hub is the only party that
 * turns a node into a path, on the machine that holds the file, and a tool
 * that took a path would be an agent choosing where a write lands -- the one
 * thing `client.ts` shapes the document frames to make unrepresentable. The
 * MCP endpoint is a projection of what a client may ask for, and a client may
 * not ask for that either.
 *
 * ## Why a parse and not a cast
 *
 * These arrive as strings off an MCP client and every function below them
 * takes a branded id or a parsed name. A cast here would be this endpoint
 * deciding that whatever a model typed is a name -- and for a document name
 * that decision is a path on somebody's disk, which is exactly what
 * `doc.ts` refuses to let a convention decide. `safeParse`, so the refusal is
 * words rather than a throw carrying zod's.
 */

/** A project or a document, as the hub's tree names one. */
export function parsedNodeId(nodeId: string): McpAnswer<NodeId> {
  const parsed = nodeIdSchema.safeParse(nodeId);
  if (!parsed.success) return refuses('a node id is one to two hundred characters');
  return { ok: true, value: parsed.data };
}

/**
 * What a document may be called.
 *
 * The whole rule in the sentence rather than "that name is invalid", because
 * every clause of it is something a caller can act on and the caller is a
 * model that will otherwise guess again: the extension list is closed, the
 * stem is ASCII, and a separator or a dot pair is what a traversal looks like.
 */
export function parsedDocName(name: string): McpAnswer<DocName> {
  const parsed = docNameSchema.safeParse(name);
  if (!parsed.success) {
    return refuses(
      'a document name is one path segment of ASCII letters, digits, dots, hyphens and ' +
        `underscores, never two dots in a row, ending in one of ${DOC_NAME_EXTENSIONS.join(', ')}`,
    );
  }
  return { ok: true, value: parsed.data };
}

/**
 * A refusal from the docs feature, as an agent reads it.
 *
 * The feature's own sentence, passed through whole and with nothing appended.
 * Unlike a session refusal there is no holder to name: a document has no live
 * process, and the one thing a caller needs to know when a machine is away --
 * which machine -- is already in the sentence the feature wrote, by the label
 * a person typed when they paired it.
 */
export function refusedDoc(refusal: DocRefusal): McpAnswer<never> {
  return refuses(refusal.problem);
}
