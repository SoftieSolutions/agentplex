import {
  nodeIdSchema,
  normaliseDirectory,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type { DirectoryOutcome, ProjectOutcome, ProjectSummary, Projects } from './projects.js';

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
 * The projects it holds are a map rather than a table, and the lookups read it
 * both ways: `findByDirectories` is what the catalogue asks as it places a
 * store's sessions, so a suite about placement can say "this directory is that project"
 * in one line without a migrated schema.
 */
export interface FakeProjects extends Projects {
  /** Every browse asked for, in order, so a suite can assert on what crossed. */
  readonly listed: readonly { server: ServerRegistrationId; directory: string | null }[];
  /** Every project made through this fake, newest last. */
  readonly created: readonly { nodeId: NodeId; name: string; directory: string }[];
  /**
   * Every lookup, in order, as the directories it asked about: what the tree
   * asked as it placed. One entry per call rather than per directory, because
   * how many times the tree asked is the question a suite about placement
   * cost has to be able to answer.
   */
  readonly looked: readonly (readonly string[])[];
  /** What every later browse answers with. */
  answerWith(outcome: DirectoryOutcome): void;
  /**
   * Puts a project in this fake without going through `create`.
   *
   * The name is optional and falls back to the node id, because most suites
   * that hold a project are asking a question about its directory and naming
   * it would be a line of noise in each of them. The one that is about the
   * listing says a name, and reads it back.
   */
  hold(nodeId: NodeId, directory: string, name?: string): void;
}

export interface FakeProjectsOptions {
  readonly outcome?: DirectoryOutcome;
}

export function createFakeProjects(options: FakeProjectsOptions = {}): FakeProjects {
  const listed: { server: ServerRegistrationId; directory: string | null }[] = [];
  const created: { nodeId: NodeId; name: string; directory: string }[] = [];
  const looked: (readonly string[])[] = [];
  const held = new Map<NodeId, { readonly name: string; readonly directory: string }>();
  let minted = 0;

  // Both sides normalised, as the real lookup compares a normalised question
  // with a row that was normalised on its way in: a suite that holds `/srv/a`
  // and reports `/srv/a/` is asking what the hub would answer.
  const holding = (directory: string): NodeId | null => {
    const asked = normaliseDirectory(directory);
    for (const [nodeId, project] of held) {
      if (normaliseDirectory(project.directory) === asked) return nodeId;
    }
    return null;
  };

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
      for (const project of held.values()) {
        if (project.directory !== request.directory) continue;
        return {
          ok: false,
          code: 'refused',
          problem: `there is already a project at ${request.directory}`,
        };
      }
      const nodeId = nodeIdSchema.parse(`project-${String((minted += 1))}`);
      held.set(nodeId, { name, directory: request.directory });
      created.push({ nodeId, name, directory: request.directory });
      return { ok: true, nodeId };
    },

    async directoryOf(nodeId: NodeId): Promise<string | null> {
      return held.get(nodeId)?.directory ?? null;
    },

    async directories(): Promise<ReadonlyMap<NodeId, string>> {
      return new Map([...held].map(([nodeId, project]) => [nodeId, project.directory]));
    },

    async list(): Promise<readonly ProjectSummary[]> {
      // Sorted the way the statement sorts, so a suite that asserts an order
      // is asserting the one the real feature answers in.
      return [...held]
        .map(([nodeId, project]) => ({ nodeId, name: project.name, directory: project.directory }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async findByDirectory(directory: string): Promise<NodeId | null> {
      looked.push([directory]);
      return holding(directory);
    },

    async findByDirectories(directories: readonly string[]): Promise<ReadonlyMap<string, NodeId>> {
      looked.push([...directories]);
      const found = new Map<string, NodeId>();
      for (const directory of directories) {
        const nodeId = holding(directory);
        if (nodeId !== null) found.set(directory, nodeId);
      }
      return found;
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

    hold(nodeId: NodeId, directory: string, name = nodeId): void {
      held.set(nodeId, { name, directory });
    },

    get listed(): readonly { server: ServerRegistrationId; directory: string | null }[] {
      return listed;
    },

    get created(): readonly { nodeId: NodeId; name: string; directory: string }[] {
      return created;
    },

    get looked(): readonly (readonly string[])[] {
      return looked;
    },
  };
}
