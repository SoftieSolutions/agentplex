import { nodeKindSchema, type NodeKind } from '@agentplex/protocol';
import { PROJECT_KIND } from '../projects/project-kind.js';

/**
 * The node kinds this build knows the names of, parsed once.
 *
 * A kind is an opaque string on the wire on purpose: migration 0004 made the
 * kinds rows so that adding one costs an INSERT rather than a schema change,
 * and a closed enum in the protocol would have undone that. The cost lands
 * here — a client comparing against one has to say which string it means
 * somewhere — and this is that somewhere, once, parsed.
 *
 * A build meeting a kind it has never heard of breaks on nothing here. It is
 * simply not a folder and not a project, so it is drawn as a plain node and
 * not offered as somewhere to put things. Which is the honest behaviour: the
 * hub holds the table saying what may contain what, and a client guessing
 * would be a second copy of an answer it does not have.
 */
export const FOLDER_KIND: NodeKind = nodeKindSchema.parse('folder');
export const SESSION_KIND: NodeKind = nodeKindSchema.parse('session');
/**
 * The doc kind, which the hub's `node_kinds` table names and this build can
 * open. It is named here so the tree can draw such a node as the leaf it is
 * and address it, rather than meeting an unknown string and drawing a
 * document as a plain node with nothing to click.
 */
export const DOC_KIND: NodeKind = nodeKindSchema.parse('doc');
/**
 * The graph kind, seeded by the hub's migration 0017 and opened by this build
 * at `#/graph/<nodeId>`. Named here for the reason the doc kind is: the tree
 * draws it as a leaf with somewhere to go rather than as a plain node.
 */
export const GRAPH_KIND: NodeKind = nodeKindSchema.parse('graph');
export { PROJECT_KIND };
