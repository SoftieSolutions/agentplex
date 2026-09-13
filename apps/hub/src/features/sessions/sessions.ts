import {
  startIdSchema,
  type NodeId,
  type Provider,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type SessionId,
  type StartId,
  type StoreId,
} from '@agentplex/protocol';
import type { IdGenerator, Logger } from '@agentplex/node-shared';
import type { Projects } from '../projects/projects.js';
import type { InstructionOutcome, ServerInstruction } from '../servers/servers.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import { routeStart, routeStop } from './session-routing.js';

/**
 * Starting and stopping sessions, from the hub's side.
 *
 * Two steps and nothing else: decide, then instruct. The deciding is
 * `session-routing.ts`, which is pure and sees the whole fleet; this is the
 * part that has a socket, and the only thing it adds is that the machine the
 * router chose is the machine the instruction is put to and the machine named
 * in the answer.
 *
 * What never happens here is any building of a command. The instruction names a
 * store, a provider and at most a session; there is nowhere in it to put an
 * argv element or an environment variable, and the server resolves both from
 * its own configuration and its own registry.
 *
 * The one field that is a value rather than a name is `directory`, and the
 * shape of this file is what keeps it narrow. A client names a *project*, which
 * is a row this hub owns; the directory is read out of that row here and
 * nowhere else, so there is no path by which a path a client typed reaches a
 * server. And what arrives at the far end is still a claim: the server refuses
 * it unless its real path sits under a root that machine's own operator
 * configured. Three parties, and the value is checked by two of them.
 *
 * ## The one name the hub does put on an instruction
 *
 * A start is minted a `StartId` here, and that is a name and not an argument
 * either: the server does nothing with it but tag the terminal it forks and
 * report the tag back. It is minted at the hub rather than at the server
 * because the hub is the one that needs to recognise the answer -- a spawn has
 * no session id until the provider writes one, and the hub that asked for it
 * must be able to say "that is mine" across a socket that dropped in between.
 * A server-minted id could not be that: the hub would not know it until the
 * answer arrived, which is the very frame a dropped socket loses.
 *
 * It is minted here rather than in the client connection because a start id
 * belongs to the instruction and not to whoever asked for one: the MCP caller
 * and the browser tab are two askers of the same thing, and an id minted per
 * asker would be a second rule about what a start is called.
 */

export interface SessionsDependencies {
  /** The state the routing decision is made against, read per request. */
  readonly state: { snapshot(): HubStateSnapshot };
  /**
   * Where a project id becomes a directory.
   *
   * The read half only. Starting a session in a project must not be able to
   * make one, and a seam that offered `create` would be a seam through which a
   * start could.
   */
  readonly projects: Pick<Projects, 'directoryOf'>;
  /** Where a start's name comes from. Injected, so a test need not match a pattern. */
  readonly ids: IdGenerator;
  /** How an instruction reaches one paired server. */
  readonly connections: {
    ask(
      registrationId: ServerRegistrationId,
      instruction: ServerInstruction,
    ): Promise<InstructionOutcome>;
  };
  readonly logger: Logger;
}

export interface StartSessionRequest {
  readonly storeId: StoreId;
  /** The session to resume, or `null` for a new one the provider will name. */
  readonly sessionId: SessionId | null;
  readonly provider: Provider;
  readonly prompt: string | null;
  /** The user's override, or `null` to let the hub schedule it. */
  readonly server: ServerRegistrationId | null;
  /**
   * The project to start in, or `null` for the store's own directory.
   *
   * An id, never a path. The directory is resolved here, out of this hub's own
   * rows, which is what makes the value that eventually reaches a server one
   * that a person chose by browsing that server rather than one a client wrote.
   */
  readonly project: NodeId | null;
}

export interface StopSessionRequest {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
}

/**
 * Why nothing happened, in the terms a client is answered in.
 *
 * It carries the holder for the same reason the wire does: "it is running over
 * here" is an answer that leads somewhere, and "no" is not. Shared by a start
 * and a stop because the reasons genuinely are the same set.
 */
export interface SessionRefused {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly problem: string;
  readonly holder: SessionHolder | null;
}

/** A session is running, or has stopped, and here is where. */
export interface SessionRan {
  readonly ok: true;
  readonly storeId: StoreId;
  /** `null` for a spawn, whose id the provider has not written yet. */
  readonly sessionId: SessionId | null;
  readonly server: ServerRegistrationId;
}

/**
 * A start also answers with the name this hub gave it.
 *
 * On the outcome and not only on the wire, because for a spawn it is the only
 * name there is until the provider writes one, and the caller that asked is
 * the one that will be shown that terminal.
 *
 * A stop has no such field and does not get one: it named a session, which
 * already has a name, so `null` there would be a field that is never anything
 * else. What is deliberately still absent is a map from a client's own start
 * handle to this one. The reader of that map is the relay, which is AGX-212,
 * and a registry with a writer and no reader is a promise nothing checks --
 * the argument `transport.ts` already makes about declaring only what is used.
 */
export interface SessionStarted extends SessionRan {
  readonly startId: StartId;
}

export type StartOutcome = SessionStarted | SessionRefused;
export type SessionOutcome = SessionRan | SessionRefused;

export interface Sessions {
  start(request: StartSessionRequest): Promise<StartOutcome>;
  stop(request: StopSessionRequest): Promise<SessionOutcome>;
}

export function createSessions(dependencies: SessionsDependencies): Sessions {
  const { state, projects, connections, ids } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  return {
    async start(request: StartSessionRequest): Promise<StartOutcome> {
      // Resolved before the routing, because a project nobody has is not a
      // placement problem: there is no machine that would make it right, and
      // the sentence a person needs is about the project rather than about the
      // fleet.
      //
      // A resume with a project is refused rather than quietly ignored. The
      // directory a session resumes in is the one its own transcript records --
      // nobody gets to choose it, here or on the server -- so a start that
      // named both was asking for two different directories, and answering it
      // with either would be picking one of them without saying so.
      let directory: string | null = null;
      if (request.project !== null) {
        if (request.sessionId !== null) {
          return {
            ok: false,
            code: 'refused',
            problem:
              'a session resumes in the directory its own transcript recorded, ' +
              'so a resume cannot be started in a project',
            holder: null,
          };
        }
        directory = await projects.directoryOf(request.project);
        if (directory === null) {
          logger.info('start refused', { project: request.project, problem: 'no such project' });
          return {
            ok: false,
            code: 'refused',
            problem: 'this hub has no project by that id',
            holder: null,
          };
        }
      }

      const routed = routeStart(state.snapshot(), {
        storeId: request.storeId,
        sessionId: request.sessionId,
        provider: request.provider,
        server: request.server,
      });
      if (!routed.ok) {
        logger.info('start refused', {
          storeId: request.storeId,
          sessionId: request.sessionId,
          problem: routed.problem,
        });
        return routed;
      }

      const { registrationId } = routed.server;
      // Minted after the routing and before the instruction: a start that was
      // refused never happened, and naming one would put an id in a log that
      // nothing on any machine will ever report back.
      const startId = startIdSchema.parse(ids.newId());
      const answered = await connections.ask(registrationId, {
        type: 'session-start',
        startId,
        storeId: request.storeId,
        sessionId: request.sessionId,
        provider: request.provider,
        prompt: request.prompt,
        directory,
      });

      if (!answered.ok) {
        logger.info('the server refused a start', {
          registrationId,
          storeId: request.storeId,
          problem: answered.problem,
        });
        return refusal(answered, registrationId);
      }

      // Narrowed on the frame the server sent rather than assumed from what was
      // asked: a peer that answered a start with a stop is a peer that is out
      // of step, and taking its word for the wrong thing would put a session in
      // front of a user that nothing is running.
      if (answered.answer.type !== 'session-started') {
        logger.error('the server answered a start with something else', {
          registrationId,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a start with something else',
          holder: null,
        };
      }

      logger.info('session started', {
        registrationId,
        storeId: answered.answer.storeId,
        sessionId: answered.answer.sessionId,
        startId,
      });
      return {
        ok: true,
        storeId: answered.answer.storeId,
        sessionId: answered.answer.sessionId,
        server: registrationId,
        startId,
      };
    },

    async stop(request: StopSessionRequest): Promise<SessionOutcome> {
      const routed = routeStop(state.snapshot(), request);
      if (!routed.ok) {
        logger.info('stop refused', { ...request, problem: routed.problem });
        return routed;
      }

      const { registrationId } = routed.server;
      const answered = await connections.ask(registrationId, {
        type: 'session-stop',
        storeId: request.storeId,
        sessionId: request.sessionId,
      });

      if (!answered.ok) {
        logger.info('the server refused a stop', { registrationId, problem: answered.problem });
        return refusal(answered, registrationId);
      }

      if (answered.answer.type !== 'session-stopped') {
        logger.error('the server answered a stop with something else', {
          registrationId,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a stop with something else',
          holder: null,
        };
      }

      logger.info('session stopped', { registrationId, ...request });
      return {
        ok: true,
        storeId: answered.answer.storeId,
        sessionId: answered.answer.sessionId,
        server: registrationId,
      };
    },
  };
}

/**
 * A server's refusal, as a client reads it.
 *
 * The hold the server named is about that server's own process, so the machine
 * on the client's holder is the machine the instruction was put to. This is the
 * only place the two are joined, and it is the reason a hold does not carry a
 * server id: the server would be naming itself to the one peer that already
 * knows which connection it answered on.
 */
function refusal(
  outcome: Extract<InstructionOutcome, { ok: false }>,
  registrationId: ServerRegistrationId,
): SessionRefused {
  return {
    ok: false,
    code: outcome.code,
    problem: outcome.problem,
    holder:
      outcome.hold === null ? null : { server: registrationId, stoppable: outcome.hold.stoppable },
  };
}
