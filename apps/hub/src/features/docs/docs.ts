import type { DocName, NodeId, RefusalCode, ServerRegistrationId } from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import type { Projects } from '../projects/projects.js';
import {
  countsTowardAttention,
  type InstructionOutcome,
  type ServerInstruction,
} from '../servers/servers.js';
import { insertDoc, findDoc, listDocs, readDoc, touchDoc, type DocRow } from './doc-rows.js';

/**
 * Documents, from the hub's side: the index, and the one path a write takes.
 *
 * A document is a file in a project's folder on one machine, under the data
 * root that machine made for itself. The hub never holds the content -- 0008
 * argues why at length -- so everything here is the same three steps in a
 * different order: turn a node id into the directory the project is, put the
 * matching document frame to the one machine that has the file, and write the
 * index only if that machine said yes.
 *
 * ## One write path, two callers
 *
 * The four functions below are the whole of what anything in this hub may do
 * to a document. The client connection calls them on a frame; the MCP tools of
 * AGX-244 call the same four in the same process. Neither reaches a server,
 * and that is the decision this feature exists to hold: a second caller that
 * put its own `doc-write` on a connection would be a second answer to what a
 * document write means -- which index rows it updates, which refusals it
 * produces, what happens when the machine is away -- and the two would drift
 * the first time one of them was fixed.
 *
 * ## What happens when a machine is not connected
 *
 * A create, a save and an open all refuse, and the refusal names the machine,
 * because the hub holds no copy to answer from. A listing does not: it is read
 * out of the index, so a project's documents can be seen, named and pointed at
 * while the machine that holds them is switched off. That asymmetry is the
 * whole value of keeping an index at all, and it is the direction that does
 * not over-claim -- a row is a claim that a file existed on that machine when
 * the hub last heard, and a listing says which machine so the claim can be
 * read for what it is.
 *
 * ## Why the index is written after the reply and never before
 *
 * `doc-rows.ts` carries this argument. In short: a row written first would
 * describe a file that may never have been created, and a node that opens as a
 * refusal forever is worse than a file on a disk that no row names.
 */

export interface DocsDependencies {
  /** Where the rows live. This feature is the only writer of the table it owns. */
  readonly database: Database;
  /** Where a document node's primary key comes from. */
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /**
   * The fleet as it is right now, read per request.
   *
   * The same seam projects takes, for the same reason: whether a machine is
   * reachable is a claim about now, and the only thing that knows is the thing
   * holding the socket. It is also where a machine's label comes from, which
   * is what a refusal and a listing name it by -- a registration id is the
   * hub's own word for a machine and means nothing to a person.
   */
  readonly state: { snapshot(): HubStateSnapshot };
  /**
   * Which directory a project is.
   *
   * Only the read, like the catalogue takes: this feature makes no project,
   * renames none and removes none. The directory is the one thing a document
   * frame needs and the one thing a client may not supply -- see `client.ts`
   * for why a doc frame carries a node id and never a path.
   */
  readonly projects: Pick<Projects, 'directoryOf'>;
  /** How an instruction reaches one paired server. */
  readonly connections: {
    ask(
      registrationId: ServerRegistrationId,
      instruction: ServerInstruction,
    ): Promise<InstructionOutcome>;
  };
  readonly logger: Logger;
  /**
   * Told when a document was made, because a document is a node and the tree
   * just changed.
   *
   * The same callback a project create fires, and for the same reason: the
   * catalogue keeps the version, every client hears `catalogue-changed`, and
   * the one that asked is not made to ask again for a change it already knows
   * about. A save does not fire it -- it changes no row the tree carries.
   */
  readonly onTreeChanged: () => void;
}

/** Why the hub said no, in the terms a client is answered in. */
export interface DocRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly problem: string;
}

export type DocCreated = { readonly ok: true; readonly nodeId: NodeId } | DocRefusal;
export type DocSaved = { readonly ok: true; readonly updatedAt: number } | DocRefusal;
export type DocOpened =
  { readonly ok: true; readonly content: string; readonly updatedAt: number } | DocRefusal;

/**
 * One document in a listing, as the hub can answer for it.
 *
 * The machine is on every row and not stated once for the listing, because a
 * project's documents are not all on one machine: the file store is under a
 * server's own exclusive data root, so "plan.md in this project" is one file
 * per machine that has been written to. `label` is what a person reads;
 * `reachable` is what says whether opening it will work right now, and it is
 * a fact about this second rather than about the row.
 */
export interface DocSummary {
  readonly nodeId: NodeId;
  readonly name: DocName;
  readonly server: ServerRegistrationId;
  readonly label: string;
  readonly reachable: boolean;
  readonly updatedAt: number;
}

export type DocListed = { readonly ok: true; readonly docs: readonly DocSummary[] } | DocRefusal;

export interface Docs {
  /**
   * Writes a new document on one machine and indexes it.
   *
   * The machine is the caller's choice and not the hub's, which is the one
   * place this differs from starting a session. A start names a store, because
   * a store is a volume more than one machine may have mounted and choosing
   * between them is the hub's job; a document is a file on one machine's disk,
   * and there is no sense in which the hub could pick for the user.
   */
  create(
    projectId: NodeId,
    server: ServerRegistrationId,
    name: DocName,
    content: string,
  ): Promise<DocCreated>;
  /** Replaces a document whole, and records when the machine says it landed. */
  save(nodeId: NodeId, content: string): Promise<DocSaved>;
  /** Reads a document back from the machine that holds it. */
  open(nodeId: NodeId): Promise<DocOpened>;
  /**
   * Every document in one project, out of the index.
   *
   * The one function here that asks no machine anything. See the header: a
   * listing that had to dial would be a listing that went empty every time a
   * laptop shut, which is the failure an index exists to prevent.
   */
  list(projectId: NodeId): Promise<DocListed>;
}

export function createDocs(dependencies: DocsDependencies): Docs {
  const { database, ids, clock, state, projects, connections, onTreeChanged } = dependencies;
  const logger = dependencies.logger.child({ part: 'docs' });

  /** The project's directory, or the refusal for a node that is not one. */
  async function directoryOf(
    projectId: NodeId,
  ): Promise<{ ok: true; directory: string } | DocRefusal> {
    const directory = await projects.directoryOf(projectId);
    if (directory === null) {
      return { ok: false, code: 'refused', problem: 'this hub has no project by that id' };
    }
    return { ok: true, directory };
  }

  /** Why that machine cannot be asked, or `null` when it can. */
  function unreachable(server: ServerRegistrationId): DocRefusal | null {
    const report = state
      .snapshot()
      .servers.find((candidate) => candidate.registrationId === server);
    if (report === undefined) {
      return { ok: false, code: 'refused', problem: 'this hub has no such server paired' };
    }
    if (!countsTowardAttention(report)) {
      return {
        ok: false,
        code: 'refused',
        problem:
          `${report.label} is not connected right now, and the hub holds no copy of its ` +
          'documents: the machine that wrote a document is the only one that can answer for it',
      };
    }
    return null;
  }

  /** What that machine is called, or its registration when the fleet forgot it. */
  function labelOf(server: ServerRegistrationId): { label: string; reachable: boolean } {
    const report = state
      .snapshot()
      .servers.find((candidate) => candidate.registrationId === server);
    if (report === undefined) return { label: server, reachable: false };
    return { label: report.label, reachable: countsTowardAttention(report) };
  }

  /** The document row, or the refusal for a node that is not one. */
  async function rowOf(nodeId: NodeId): Promise<{ ok: true; row: DocRow } | DocRefusal> {
    const row = await readDoc(database, nodeId);
    if (row === null) {
      return { ok: false, code: 'refused', problem: 'this hub has no document by that id' };
    }
    return { ok: true, row };
  }

  return {
    async create(
      projectId: NodeId,
      server: ServerRegistrationId,
      name: DocName,
      content: string,
    ): Promise<DocCreated> {
      const away = unreachable(server);
      if (away !== null) return away;

      const project = await directoryOf(projectId);
      if (!project.ok) return project;

      // Checked before the write rather than only after it, and this is the
      // check that matters: a `doc-write` replaces a file whole, so asking
      // first and finding the duplicate afterwards would mean the user's
      // second create had already overwritten their first document. The unique
      // index is still what makes two racing creates come out right; this is
      // what keeps the common mistake from costing a file.
      if ((await findDoc(database, projectId, server, name)) !== null) {
        return {
          ok: false,
          code: 'refused',
          problem:
            `that project already has a document called ${name} on ${labelOf(server).label}: ` +
            'open it, or give this one another name',
        };
      }

      const answered = await connections.ask(server, {
        type: 'doc-write',
        directory: project.directory,
        name,
        content,
      });
      if (!answered.ok) {
        // The machine's own sentence, passed through. It names the file and the
        // reason its disk gave, and rewriting it here would replace the only
        // words that know which machine this was.
        logger.info('a server refused a document write', {
          server,
          name,
          problem: answered.problem,
        });
        return { ok: false, code: answered.code, problem: answered.problem };
      }
      if (answered.answer.type !== 'doc-written') {
        logger.error('a server answered a document write with something else', {
          server,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a document write with something else',
        };
      }

      const inserted = await insertDoc(database, ids, clock, {
        projectNodeId: projectId,
        server,
        name,
        updatedAt: answered.answer.updatedAt,
      });
      if (!inserted.ok) {
        // Two creates raced and the other one landed. The file is written
        // either way -- both wrote the same name on the same machine -- so
        // what is refused is the second node, not the content.
        return {
          ok: false,
          code: 'refused',
          problem: `that project already has a document called ${name} on ${labelOf(server).label}`,
        };
      }

      logger.info('document created', { nodeId: inserted.nodeId, server, name });
      onTreeChanged();
      return { ok: true, nodeId: inserted.nodeId };
    },

    async save(nodeId: NodeId, content: string): Promise<DocSaved> {
      const found = await rowOf(nodeId);
      if (!found.ok) return found;
      const { row } = found;

      const away = unreachable(row.server);
      if (away !== null) return away;

      const project = await directoryOf(row.projectNodeId);
      if (!project.ok) return project;

      const answered = await connections.ask(row.server, {
        type: 'doc-write',
        directory: project.directory,
        name: row.name,
        content,
      });
      if (!answered.ok) {
        logger.info('a server refused a document save', {
          nodeId,
          server: row.server,
          problem: answered.problem,
        });
        return { ok: false, code: answered.code, problem: answered.problem };
      }
      if (answered.answer.type !== 'doc-written') {
        logger.error('a server answered a document save with something else', {
          nodeId,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a document write with something else',
        };
      }

      const { updatedAt } = answered.answer;
      await touchDoc(database, nodeId, updatedAt);
      return { ok: true, updatedAt };
    },

    async open(nodeId: NodeId): Promise<DocOpened> {
      const found = await rowOf(nodeId);
      if (!found.ok) return found;
      const { row } = found;

      const away = unreachable(row.server);
      if (away !== null) return away;

      const project = await directoryOf(row.projectNodeId);
      if (!project.ok) return project;

      const answered = await connections.ask(row.server, {
        type: 'doc-read',
        directory: project.directory,
        name: row.name,
      });
      if (!answered.ok) {
        logger.info('a server refused a document read', {
          nodeId,
          server: row.server,
          problem: answered.problem,
        });
        return { ok: false, code: answered.code, problem: answered.problem };
      }
      if (answered.answer.type !== 'doc-content') {
        logger.error('a server answered a document read with something else', {
          nodeId,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a document read with something else',
        };
      }

      const { content, updatedAt } = answered.answer;
      // A read is how the hub finds out its index is behind: the file is
      // editable on the machine that holds it, by a person or by the agent the
      // document was written for, and the reply is the only evidence of that
      // this hub will ever get. Written only when it differs, so an open is a
      // read on the common path.
      if (updatedAt !== row.updatedAt) await touchDoc(database, nodeId, updatedAt);
      return { ok: true, content, updatedAt };
    },

    async list(projectId: NodeId): Promise<DocListed> {
      const project = await directoryOf(projectId);
      if (!project.ok) return project;

      const rows = await listDocs(database, projectId);
      return {
        ok: true,
        docs: rows.map((row) => {
          const { label, reachable } = labelOf(row.server);
          return {
            nodeId: row.nodeId,
            name: row.name,
            server: row.server,
            label,
            reachable,
            updatedAt: row.updatedAt,
          };
        }),
      };
    },
  };
}
