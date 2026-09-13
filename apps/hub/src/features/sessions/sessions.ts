import {
  startIdSchema,
  type Provider,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type SessionId,
  type StartId,
  type StoreId,
} from '@agentplex/protocol';
import type { IdGenerator, Logger } from '@agentplex/node-shared';
import type { InstructionOutcome, SessionInstruction } from '../servers/servers.js';
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
 * argv element, an environment variable or a working directory, and the server
 * resolves all three from its own configuration and its own registry. That is
 * the same rule stated in three places -- the frame has no field, the hub has
 * no value to put in one, and the server takes none -- and it holds because
 * each of them holds alone.
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
  /** Where a start's name comes from. Injected, so a test need not match a pattern. */
  readonly ids: IdGenerator;
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
  const { state, connections, ids } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  return {
    async start(request: StartSessionRequest): Promise<StartOutcome> {
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
