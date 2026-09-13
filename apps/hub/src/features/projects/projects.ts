import type {
  DirectoryEntry,
  NodeId,
  RefusalCode,
  ServerRegistrationId,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import {
  countsTowardAttention,
  type InstructionOutcome,
  type ServerInstruction,
} from '../servers/servers.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import {
  findProjectByDirectory,
  insertProject,
  readProjectDirectories,
  readProjectDirectory,
} from './project-rows.js';

/**
 * Projects, from the hub's side: the rows, and the browse a directory is picked
 * with.
 *
 * A project is a name and a directory -- a repository, typically -- and the
 * sessions in it are the sessions that ran there. This feature owns both halves
 * of that: the browse a user picks the directory by, and the two rows that make
 * the project once they have.
 *
 * ## What a project is not tied to
 *
 * A server. The directory is a path, and more than one machine may have that
 * checkout at that path; the laptop that happened to be awake when somebody
 * browsed is not the machine that has to run it. So `create` takes no server,
 * stores no server, and the directory it is given is *not* checked against
 * anybody's browse roots here -- the hub holds no server's root list and a copy
 * of one would be a second answer to a question only that machine can answer.
 * The check happens where it can: at the moment a session is started in the
 * project, on the machine that is about to spawn, against the roots its own
 * operator configured.
 *
 * The cost of that, stated plainly: a project can be made for a directory no
 * connected server has, and nothing says so until the first start. The
 * alternative was checking against whichever server was being browsed, which
 * would either bind the project to that machine or answer a question about a
 * different one.
 *
 * ## The browse
 *
 * Two steps and nothing else: refuse if the server is not connected, and put
 * the instruction to it. The rule about which directories may be listed is
 * deliberately not here either, and for the same reason.
 */

export interface ProjectsDependencies {
  /** Where the rows live. This feature is the only writer of the two it owns. */
  readonly database: Database;
  /** Where a project node's primary key comes from. */
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /**
   * The fleet as it is right now, read per request.
   *
   * The same seam the sessions feature takes, for the same reason: whether a
   * machine is reachable is a claim about now, and the only thing that knows is
   * the thing holding the socket.
   */
  readonly state: { snapshot(): HubStateSnapshot };
  /** How an instruction reaches one paired server. */
  readonly connections: {
    ask(
      registrationId: ServerRegistrationId,
      instruction: ServerInstruction,
    ): Promise<InstructionOutcome>;
  };
  readonly logger: Logger;
  /**
   * Told when a project was made, because a project is a node and the tree just
   * changed.
   *
   * A callback rather than this feature holding the catalogue, and the
   * direction is the point: the catalogue reads projects (to file a session
   * under the one whose directory it ran in) and projects reads nothing of the
   * catalogue's. What crosses here is one fact with no return value, wired in
   * `hub.ts`, which is the only file that knows both exist.
   */
  readonly onTreeChanged: () => void;
}

/**
 * What a browse came back with, in the terms a client is answered in.
 *
 * `roots` is carried on the success rather than left to the client to remember
 * from an earlier reply: the breadcrumb has to stop somewhere, and where it
 * stops is the server's answer.
 */
export type DirectoryOutcome =
  | {
      readonly ok: true;
      /** What was listed, or `null` for the listing of roots. */
      readonly directory: string | null;
      readonly roots: readonly string[];
      readonly entries: readonly DirectoryEntry[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

/**
 * What making a project came to, in the terms a client is answered in.
 *
 * The refusal carries a sentence and no node id. Naming the project that
 * already holds a directory was the other option -- a session refusal names its
 * holder, because "it is running over here" leads somewhere -- and it was
 * dropped because nothing would read it: the refusal frame has no field for a
 * node, so the id would travel from here to the connection and stop. A value
 * nothing reads is one that goes wrong without anybody finding out, and the
 * sentence already says which directory the user should go looking for.
 */
export type ProjectOutcome =
  | { readonly ok: true; readonly nodeId: NodeId }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

export interface Projects {
  /**
   * Makes a project, or says why not.
   *
   * Two refusals, each its own sentence because they are two different things
   * for a person to do: type a name, or go to the project they already have.
   * Neither is a closed socket -- see `layout.ts` for why a blank name reaches
   * here at all rather than failing the frame's parser.
   */
  create(request: { readonly name: string; readonly directory: string }): Promise<ProjectOutcome>;
  /**
   * Where that project is, or `null` when the node is not a project.
   *
   * The one read a start makes. It is the hub's job and nobody else's: the
   * client names a project by id and never by path, so this is the only place
   * an id becomes a directory that may reach a server.
   */
  directoryOf(nodeId: NodeId): Promise<string | null>;
  /**
   * The project whose directory this is, or `null` when none is.
   *
   * What the catalogue asks as it places a session: a session whose reported
   * `cwd` is a project's directory belongs in that project. Normalisation is
   * this feature's, so a caller hands over whatever a server reported.
   */
  findByDirectory(directory: string): Promise<NodeId | null>;
  /**
   * Every project's directory, by node, in one read.
   *
   * The catalogue query's, and the reason it is on this interface rather than a
   * `SELECT` in the catalogue: the `projects` table is this feature's, and a
   * second reader of it would be a second answer to what a project is. What the
   * query needs is the directory on a project item and nothing else, which is
   * this map -- it makes no project, renames none, and the edge still runs one
   * way.
   */
  directories(): Promise<ReadonlyMap<NodeId, string>>;
  /**
   * Lists a directory on one paired server, or says why not.
   *
   * The server is named by the caller and is not the hub's to choose, which is
   * the one place this differs from starting a session. A start names a store,
   * because a store is a volume more than one machine may have mounted and
   * picking between them is the hub's decision; a directory is a fact about one
   * machine's disk, and there is no sense in which the hub could pick for the
   * user.
   *
   * `null` lists that server's roots, which is how a browse begins.
   */
  listDirectory(server: ServerRegistrationId, directory: string | null): Promise<DirectoryOutcome>;
}

export function createProjects(dependencies: ProjectsDependencies): Projects {
  const { database, ids, clock, state, connections, onTreeChanged } = dependencies;
  const logger = dependencies.logger.child({ part: 'projects' });

  return {
    async create(request: {
      readonly name: string;
      readonly directory: string;
    }): Promise<ProjectOutcome> {
      const name = request.name.trim();
      if (name === '') {
        return { ok: false, code: 'refused', problem: 'a project needs a name' };
      }

      const inserted = await insertProject(database, ids, clock, {
        name,
        directory: request.directory,
      });
      if (!inserted.ok) {
        logger.info('project refused', { directory: request.directory, reason: 'duplicate' });
        return {
          ok: false,
          code: 'refused',
          problem:
            `there is already a project at ${request.directory}: one directory is one project, ` +
            'because a session that ran there has to belong to a definite one of them',
        };
      }

      logger.info('project created', { nodeId: inserted.nodeId, directory: request.directory });
      onTreeChanged();
      return { ok: true, nodeId: inserted.nodeId };
    },

    directoryOf: (nodeId: NodeId) => readProjectDirectory(database, nodeId),

    findByDirectory: (directory: string) => findProjectByDirectory(database, directory),

    directories: () => readProjectDirectories(database),

    async listDirectory(
      server: ServerRegistrationId,
      directory: string | null,
    ): Promise<DirectoryOutcome> {
      const refusal = notBrowsable(state.snapshot(), server);
      if (refusal !== null) {
        logger.info('browse refused', { server, directory, problem: refusal.problem });
        return refusal;
      }

      const answered = await connections.ask(server, { type: 'directory-list', directory });
      if (!answered.ok) {
        // The server's own sentence, passed through. It names the path the user
        // asked for and the setting an operator would change, and rewriting it
        // here would replace the only words that know which machine this was.
        logger.info('the server refused a browse', {
          server,
          directory,
          problem: answered.problem,
        });
        return { ok: false, code: answered.code, problem: answered.problem };
      }

      // Narrowed on the frame the server sent rather than assumed from what was
      // asked, for the reason a start is: a peer that answered a browse with a
      // session is a peer that is out of step, and taking its word for the wrong
      // thing would put a listing in front of a user that describes nothing.
      if (answered.answer.type !== 'directory-listing') {
        logger.error('the server answered a browse with something else', {
          server,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a directory listing with something else',
        };
      }

      const { answer } = answered;
      return {
        ok: true,
        directory: answer.directory,
        roots: answer.roots,
        entries: answer.entries,
        truncated: answer.truncated,
      };
    },
  };
}

/**
 * Why that server cannot be asked, or `null` when it can.
 *
 * Two refusals and not one, because they are two different things for a person
 * to do. A registration this hub has never heard of is a client naming a
 * machine that is not in the fleet it was sent -- a stale tab, or a bug -- and
 * a machine that is paired and unreachable is a machine somebody may be able to
 * go and switch on. Both are `refused` rather than `internal`: the hub
 * understood and declined, and retrying changes neither.
 */
function notBrowsable(
  snapshot: HubStateSnapshot,
  server: ServerRegistrationId,
): Extract<DirectoryOutcome, { ok: false }> | null {
  const report = snapshot.servers.find((candidate) => candidate.registrationId === server);
  if (report === undefined) {
    return { ok: false, code: 'refused', problem: 'this hub has no such server paired' };
  }
  if (!countsTowardAttention(report)) {
    return {
      ok: false,
      code: 'refused',
      problem: `${report.label} is not connected right now, so its directories cannot be read`,
    };
  }
  return null;
}
