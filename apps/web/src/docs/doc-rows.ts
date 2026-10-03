import type { Layout, NodeId } from '@agentplex/protocol';
import { projectChoices } from '../projects/new-project-model.js';
import { DOC_KIND } from '../tree/node-kinds.js';

/**
 * The documents in the tree, grouped under the projects they belong to.
 *
 * Read off the layout rather than out of a listing of its own, because that is
 * what a document is here: a node of kind `doc`, whose parent is the project
 * node and whose name is the file's name. The hub answers `layout-request`
 * with every node it has, so the tree a client already asks for carries the
 * documents too, and no second round trip says what a project holds.
 *
 * ## What a row deliberately does not claim
 *
 * A document is a file on one machine -- the file store sits under a server's
 * own data root, so "plan.md in this project" is one file per machine that has
 * been written to -- and a layout node carries no server. There is no client
 * frame that lists documents with their machines either: the hub's `list` is
 * an index read with a label on every row, and only the MCP tools call it.
 *
 * So a row here names the document and the project, and says nothing about
 * which machine holds it. Guessing would be the over-claim, and the guess
 * would be wrong in exactly the case the index exists for: two machines with
 * the same checkout, each holding its own `plan.md`, are two nodes here with
 * one name. Which machine a document is on is said where a client can say it
 * honestly -- the New doc form names the machine it is writing to, and an open
 * that is refused because that machine is away names it in the refusal.
 */

/** One document, as a row offers it: the node to open, and what it is called. */
export interface DocRow {
  readonly nodeId: NodeId;
  readonly name: string;
}

/** One project, with the documents the tree hangs under it. */
export interface ProjectDocs {
  readonly projectId: NodeId;
  readonly label: string;
  readonly docs: readonly DocRow[];
}

/**
 * Every project in the tree with its documents, in the order the hub sent.
 *
 * A node with no name is skipped, for the reason the project picker skips one:
 * a row a person cannot read is a row they cannot choose on purpose. A
 * document whose parent is no project in this layout is skipped too -- it is a
 * node this client cannot place, and placing it somewhere invented would be
 * the listing paying for one row it could not read.
 *
 * HOME is left out, and every document under it with it. HOME has no
 * directory, so the hub keeps no project row for it and refuses every document
 * act there; a HOME row here would carry a New doc action that could only be
 * refused. The documents migration 0020 moved into HOME are not lost by this:
 * the Projects tree still draws them where they are.
 */
export function projectDocuments(layout: Layout | null): readonly ProjectDocs[] {
  const projects = new Map<NodeId, { label: string; docs: DocRow[] }>();
  for (const choice of projectChoices(layout, { includeHome: false })) {
    projects.set(choice.id, { label: choice.label, docs: [] });
  }
  if (layout === null) return [];
  for (const node of layout) {
    if (node.kind !== DOC_KIND || node.name === null || node.parentId === null) continue;
    projects.get(node.parentId)?.docs.push({ nodeId: node.id, name: node.name });
  }
  return [...projects].map(([projectId, { label, docs }]) => ({ projectId, label, docs }));
}

/** What that document is called, or `null` for a node that is not one. */
export function documentName(layout: Layout | null, nodeId: NodeId): string | null {
  if (layout === null) return null;
  const node = layout.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.kind !== DOC_KIND) return null;
  return node.name;
}
