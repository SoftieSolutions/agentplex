import { nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { refuses, type McpAnswer } from './tool-registry.js';

/**
 * The one word every tool that names something in the tree takes.
 *
 * Its own file rather than a second copy in each of the two that need it, and
 * rather than staying in `doc-args.ts` where it began: a node id is the tree's
 * vocabulary and not a document's. `doc_read` names a document by one,
 * `doc_list` and `doc_create` name a project by one, and `start_session` names
 * the project it spawns in by one -- five tools, one sentence, which is what
 * lets an agent branch on the answer instead of matching five phrasings of one
 * fact.
 *
 * ## A node id, and never a path
 *
 * This is the whole of how a tool may say *where*. The hub is the only party
 * that turns a node into a directory -- `sessions.ts` for a spawn,
 * `docs.ts` for a write -- and what it resolves comes out of this hub's own
 * rows, which hold only directories somebody picked by browsing a machine. A
 * tool that took a path would be an agent choosing where a process runs or a
 * file lands, which is the one thing `client.ts` shapes these frames to make
 * unrepresentable; the MCP endpoint is a projection of what a client may ask
 * for, and a client may not ask for that either.
 *
 * ## Why a parse and not a cast
 *
 * It arrives as a string off an MCP client and everything below takes a
 * branded id. A cast here would be this endpoint deciding that whatever a
 * model typed is an id, which is the decision `parse, never cast` exists to
 * stop. `safeParse`, so a string that is not one is refused in words rather
 * than in a throw carrying zod's.
 */
export function parsedNodeId(nodeId: string): McpAnswer<NodeId> {
  const parsed = nodeIdSchema.safeParse(nodeId);
  if (!parsed.success) return refuses('a node id is one to two hundred characters');
  return { ok: true, value: parsed.data };
}
