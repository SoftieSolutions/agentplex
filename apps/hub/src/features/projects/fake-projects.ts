import { nodeIdSchema, type NodeId, type ServerRegistrationId } from '@agentplex/protocol';
import type { DirectoryOutcome, ProjectOutcome, Projects } from './projects.js';

/**
 * The hub's projects, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-sessions.ts` is one: what a client connection has to get right is what
 * it does with an outcome -- a project's id, a refusal naming the project that
 * already holds a directory, a listing, a machine that is not connected -- and
 * each of those is a value this hands back. The rows and the relay are tested
 * where they live, and end to end against a real server over a real handshake.
 * This is for the tests whose subject is the socket.
 *
 * The directories it holds are a map rather than a table, and the lookups read
 * it both ways: `findByDirectory` is what the catalogue asks as it places a
 * session, so a suite about placement can say "this directory is that project"
 * in one line without a migrated schema.
 */
export interface FakeProjects extends Projects {
  /** Every browse asked for, in order, so a suite can assert on what crossed. */
  readonly listed: readonly { server: ServerRegistrationId; directory: string | null }[];
  /** Every project made through this fake, newest last. */
  readonly created: readonly { nodeId: NodeId; name: string; directory: string }[];
  /** Every directory looked up, in order: what the tree asked as it placed. */
  readonly looked: readonly string[];
  /** What every later browse answers with. */
  answerWith(outcome: DirectoryOutcome): void;
  /** Puts a project in this fake without going through `create`. */
  hold(nodeId: NodeId, directory: string): void;
}

export interface FakeProjectsOptions {
  readonly outcome?: DirectoryOutcome;
}

export function createFakeProjects(options: FakeProjectsOptions = {}): FakeProjects {
  const listed: { server: ServerRegistrationId; directory: string | null }[] = [];
  const created: { nodeId: NodeId; name: string; directory: string }[] = [];
  const looked: string[] = [];
  const directories = new Map<NodeId, string>();
  let minted = 0;

  let outcome: DirectoryOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake was given no answer',
  };

  return {
    async create(request: {
      readonly name: string;
      readonly directory: string;
    }): Promise<ProjectOutcome> {
      const name = request.name.trim();
      if (name === '') {
        return { ok: false, code: 'refused', problem: 'a project needs a name' };
      }
      for (const directory of directories.values()) {
        if (directory !== request.directory) continue;
        return {
          ok: false,
          code: 'refused',
          problem: `there is already a project at ${request.directory}`,
        };
      }
      const nodeId = nodeIdSchema.parse(`project-${String((minted += 1))}`);
      directories.set(nodeId, request.directory);
      created.push({ nodeId, name, directory: request.directory });
      return { ok: true, nodeId };
    },

    async directoryOf(nodeId: NodeId): Promise<string | null> {
      return directories.get(nodeId) ?? null;
    },

    async findByDirectory(directory: string): Promise<NodeId | null> {
      looked.push(directory);
      for (const [nodeId, held] of directories) if (held === directory) return nodeId;
      return null;
    },

    async listDirectory(
      server: ServerRegistrationId,
      directory: string | null,
    ): Promise<DirectoryOutcome> {
      listed.push({ server, directory });
      return outcome;
    },

    answerWith(next: DirectoryOutcome): void {
      outcome = next;
    },

    hold(nodeId: NodeId, directory: string): void {
      directories.set(nodeId, directory);
    },

    get listed(): readonly { server: ServerRegistrationId; directory: string | null }[] {
      return listed;
    },

    get created(): readonly { nodeId: NodeId; name: string; directory: string }[] {
      return created;
    },

    get looked(): readonly string[] {
      return looked;
    },
  };
}
