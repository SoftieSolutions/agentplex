import { nodeKindSchema, type NodeKind } from '@agentplex/protocol';

/**
 * What a project node's kind is called, parsed once for the client.
 *
 * A kind is an opaque string on the wire on purpose -- migration 0004 made the
 * kinds rows so that adding one costs an INSERT rather than a schema change,
 * and a closed enum in the protocol would have undone that. The cost is that a
 * client comparing against one has to say which string it means somewhere, and
 * this is that somewhere: once, parsed, rather than a literal spelled out in
 * each screen that cares.
 *
 * A build meeting a kind it has never heard of is the case this shape is for.
 * Nothing here breaks on one; it is simply not a project.
 */
export const PROJECT_KIND: NodeKind = nodeKindSchema.parse('project');
