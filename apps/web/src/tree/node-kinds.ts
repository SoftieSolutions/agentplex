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
export { PROJECT_KIND };
