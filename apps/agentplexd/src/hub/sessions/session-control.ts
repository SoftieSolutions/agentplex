import type {
  Provider,
  RefusalCode,
  ServerRegistrationId,
  SessionHolder,
  SessionId,
  StoreId,
} from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import type { InstructionOutcome, SessionInstruction } from '../connections/server-connection.js';
import type { HubStateSnapshot } from '../state/reducer.js';
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
 * argv element, an environment variable or a working directory, and the server
 * resolves all three from its own configuration and its own registry. That is
 * the same rule stated in three places -- the frame has no field, the hub has
 * no value to put in one, and the server takes none -- and it holds because
 * each of them holds alone.
 */

export interface SessionControlDependencies {
  /** The state the routing decision is made against, read per request. */
  readonly state: { snapshot(): HubStateSnapshot };
  /** How an instruction reaches one paired server. */
  readonly connections: {
    ask(
      registrationId: ServerRegistrationId,
      instruction: SessionInstruction,
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
}

export interface StopSessionRequest {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
}

/**
 * What happened, in the terms a client is answered in.
 *
 * The refusal half carries the holder for the same reason the wire does: "it is
 * running over here" is an answer that leads somewhere, and "no" is not.
 */
export type SessionOutcome =
  | {
      readonly ok: true;
      readonly storeId: StoreId;
      /** `null` for a spawn, whose id the provider has not written yet. */
      readonly sessionId: SessionId | null;
      readonly server: ServerRegistrationId;
    }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly holder: SessionHolder | null;
    };

export interface SessionControl {
  start(request: StartSessionRequest): Promise<SessionOutcome>;
  stop(request: StopSessionRequest): Promise<SessionOutcome>;
}

export function createSessionControl(dependencies: SessionControlDependencies): SessionControl {
  const { state, connections } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  return {
    async start(request: StartSessionRequest): Promise<SessionOutcome> {
      const routed = routeStart(state.snapshot(), {
        storeId: request.storeId,
        sessionId: request.sessionId,
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
      const answered = await connections.ask(registrationId, {
        type: 'session-start',
        storeId: request.storeId,
        sessionId: request.sessionId,
        provider: request.provider,
        prompt: request.prompt,
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
      });
      return {
        ok: true,
        storeId: answered.answer.storeId,
        sessionId: answered.answer.sessionId,
        server: registrationId,
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
): SessionOutcome {
  return {
    ok: false,
    code: outcome.code,
    problem: outcome.problem,
    holder:
      outcome.hold === null ? null : { server: registrationId, stoppable: outcome.hold.stoppable },
  };
}
