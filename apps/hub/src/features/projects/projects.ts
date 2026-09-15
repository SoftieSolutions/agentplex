import type { DirectoryEntry, RefusalCode, ServerRegistrationId } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import {
  countsTowardAttention,
  type InstructionOutcome,
  type ServerInstruction,
} from '../servers/servers.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';

/**
 * Projects, from the hub's side.
 *
 * A project is a directory on one machine, and this is the feature that owns
 * what the hub knows about one. Today that is the first half only -- browsing,
 * so the user can pick a directory -- and AGX-133 adds the record, the
 * migration and the tree node on top of it. The folder exists now rather than
 * later because the browse is the thing a project form is built out of, and
 * hanging it off the sessions feature would put "which directory" next to
 * "which machine runs this", which are not the same question.
 *
 * The whole of the relay is two steps: refuse if the server is not connected,
 * and put the instruction to it. The rule about which directories may be
 * listed is deliberately not here. It lives on the server, over roots that
 * server's operator configured, because the hub cannot know what is on somebody
 * else's disk and a second copy of the answer here would be a second answer.
 * What the hub adds is the one fact the server cannot have: whether there is a
 * connection to ask down at all.
 */

export interface ProjectsDependencies {
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

export interface Projects {
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
  const { state, connections } = dependencies;
  const logger = dependencies.logger.child({ part: 'projects' });

  return {
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
