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
 * The doc kind, which the hub's `node_kinds` table already names and nothing
 * in this build can open: the rows that make a node a doc, and the frames that
 * read one, are stack D's. It is named here so the tree can draw such a node
 * as the leaf it is and say what it needs, rather than meeting an unknown
 * string and drawing a doc as a plain node with no explanation on it.
 */
export const DOC_KIND: NodeKind = nodeKindSchema.parse('doc');
export { PROJECT_KIND };
