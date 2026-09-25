import {
  startIdSchema,
  type Activity,
  type NodeId,
  type Provider,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type PauseTaken,
  type SessionId,
  type StartId,
  type StoreId,
} from '@agentplex/protocol';
import type { IdGenerator, Logger } from '@agentplex/node-shared';
import type { Projects } from '../projects/projects.js';
import type { InstructionOutcome, ServerAnswer, ServerInstruction } from '../servers/servers.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import { routePause, routeSessionRead, routeStart, routeStop } from './session-routing.js';

/**
 * Starting sessions, stopping them, and reading one's transcript, from the
 * hub's side.
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
  /**
   * Called with every start this hub actually made, and the prompt it was made
   * with.
   *
   * A callback rather than a feature to call, so that this one goes on holding
   * no rows: the composition root wires it to the tasks feature, which owns the
   * table, and a write to this hub's own disk stays off the seam that carries
   * an instruction to somebody else's machine. `tasks.ts` argues why the prompt
   * is worth keeping and why a transcript is no substitute for it.
   *
   * Awaited, so a client's `session-started` reply does not race the row behind
   * it. Its failure is not the start's, and is caught here: the session is
   * running by the time this is called, and refusing a start because a label
   * could not be written would be a "no" about something that already happened.
   */
  readonly onStarted: (started: StartedSession) => Promise<void>;
}

/** A start that happened, as the thing that records what it was for reads it. */
export interface StartedSession {
  readonly startId: StartId;
  readonly storeId: StoreId;
  /** `null` for a spawn, whose id the provider has not written yet. */
  readonly sessionId: SessionId | null;
  /** What the person asked for, or `null` for a start at the agent's own prompt. */
  readonly prompt: string | null;
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

/** A pause and a resume address a session exactly as a stop does. */
export type PauseSessionRequest = StopSessionRequest;

export interface TranscriptRequest {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  /**
   * How many activities to ask for, as the client asked.
   *
   * Passed through rather than re-decided here: the protocol's own schema
   * bounded it on the way in, at both ends of both legs, and a hub that also
   * had an opinion would be a third place to keep one number in step.
   */
  readonly count: number;
}

/**
 * One session's transcript as the hub relays it, or why it relayed none.
 *
 * Nothing is stored. The hub holds no copy of a transcript and no index of one:
 * the file is on the machine that wrote it, the tail of it comes back or a
 * refusal does, and a session on a machine that is not connected is that
 * refusal with the situation named in it. The same cost a document read takes
 * deliberately, for the same reason -- content only the machine that has it can
 * answer for.
 */
export type TranscriptOutcome =
  | {
      readonly ok: true;
      readonly activities: readonly Activity[];
      readonly olderExist: boolean;
    }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

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

/** What a start would be routed with: a store, a provider, and the override if there is one. */
export interface StartPlacementRequest {
  readonly storeId: StoreId;
  readonly provider: Provider;
  /** The pinned machine, or `null` to let the hub schedule it. */
  readonly server: ServerRegistrationId | null;
}

/** The machine a start would land on, named, or why no machine would take it. */
export type StartPlacement =
  | {
      readonly ok: true;
      readonly server: ServerRegistrationId;
      /** What the machine is called, for a sentence a person reads. */
      readonly label: string;
    }
  | { readonly ok: false; readonly problem: string };
export type SessionOutcome = SessionRan | SessionRefused;

/**
 * A pause was taken, and how far it got.
 *
 * `pause` is the server's word and is relayed, never restated: `requested`
 * when the pause is recorded for the next boundary, `paused` when it was at
 * one. Never `none`: the wire refuses a receipt saying so, and a server whose
 * pause was undone before it could answer sends a refusal instead. The client
 * that asked reads the word to know whether to say "pausing" or "paused";
 * every other client reads the same word off the holder on the next machine
 * state.
 */
export interface SessionPaused {
  readonly ok: true;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly server: ServerRegistrationId;
  readonly pause: PauseTaken;
}

/**
 * A resume was taken. No pause word, because the only one it could carry is
 * `none`, and a field that is never anything else is a field nobody reads.
 */
export interface SessionResumed {
  readonly ok: true;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly server: ServerRegistrationId;
}

export type PauseOutcome = SessionPaused | SessionRefused;
export type ResumeOutcome = SessionResumed | SessionRefused;

export interface Sessions {
  start(request: StartSessionRequest): Promise<StartOutcome>;
  /**
   * Where a new session would start, asked of the same routing a start takes
   * and without starting anything: no id is minted, no machine is asked and
   * nothing is recorded. A simulated AGENT step is what asks, so that the
   * machine it names is the machine a run would have used, by the one
   * scheduler this hub has rather than a second reading of it.
   */
  placeStart(request: StartPlacementRequest): StartPlacement;
  stop(request: StopSessionRequest): Promise<SessionOutcome>;
  /** Sets a session down at its next turn boundary. Routed like a stop; kills nothing. */
  pause(request: PauseSessionRequest): Promise<PauseOutcome>;
  /** Picks a paused session up again. A server that cannot answers with a refusal. */
  resume(request: PauseSessionRequest): Promise<ResumeOutcome>;
  /**
   * The tail of one session's work, read on the machine that has the file.
   *
   * Here rather than in a feature of its own because it is routed by session,
   * and session routing is this feature's: a `transcripts` feature would have
   * had to reach into `session-routing.ts`, which is not this feature's entry
   * file, or have the routing exported through it -- either way the boundary
   * moves to accommodate a method. What it shares with `stop` is the whole of
   * its decision; what it shares with the document feature is its shape.
   */
  transcript(request: TranscriptRequest): Promise<TranscriptOutcome>;
}

export function createSessions(dependencies: SessionsDependencies): Sessions {
  const { state, projects, connections, ids, onStarted } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  /**
   * The half a pause and a resume share: the routing, the question put to
   * the server, and the refusal. One function so that the routing and the
   * refusal cannot drift between them; what each makes of the answer is its
   * own, because the two receipts are different shapes.
   */
  async function askPause(
    request: PauseSessionRequest,
    instruction: 'session-pause' | 'session-resume',
  ): Promise<
    | {
        readonly ok: true;
        readonly registrationId: ServerRegistrationId;
        readonly answer: ServerAnswer;
      }
    | SessionRefused
  > {
    const verb = instruction === 'session-pause' ? 'pause' : 'resume';
    const routed = routePause(state.snapshot(), request);
    if (!routed.ok) {
      logger.info(`${verb} refused`, { ...request, problem: routed.problem });
      return routed;
    }

    const { registrationId } = routed.server;
    const answered = await connections.ask(registrationId, {
      type: instruction,
      storeId: request.storeId,
      sessionId: request.sessionId,
    });

    if (!answered.ok) {
      logger.info(`the server refused a ${verb}`, { registrationId, problem: answered.problem });
      return refusal(answered, registrationId);
    }
    return { ok: true, registrationId, answer: answered.answer };
  }

  /** The server answered the instruction with a frame that is not its receipt. */
  function answeredWithSomethingElse(
    verb: 'pause' | 'resume',
    registrationId: ServerRegistrationId,
    answered: ServerAnswer['type'],
  ): SessionRefused {
    logger.error(`the server answered a ${verb} with something else`, {
      registrationId,
      answered,
    });
    return {
      ok: false,
      code: 'internal',
      problem: `the server answered a ${verb} with something else`,
      holder: null,
    };
  }

  return {
    placeStart(request: StartPlacementRequest): StartPlacement {
      const routed = routeStart(state.snapshot(), { ...request, sessionId: null });
      if (!routed.ok) return { ok: false, problem: routed.problem };
      return {
        ok: true,
        server: routed.server.registrationId,
        label: routed.server.label,
      };
    },

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

      // What the session was started to do, told to whoever keeps that, and
      // never told to a server: the prompt reached the agent on the
      // instruction above, as one argv element the adapter placed, and this
      // path only records it. A failure here costs the label and not the
      // session, which is running whatever this hub manages to write down.
      try {
        await onStarted({
          startId,
          storeId: answered.answer.storeId,
          sessionId: answered.answer.sessionId,
          prompt: request.prompt,
        });
      } catch (error) {
        logger.warn('a started session kept no task', {
          startId,
          storeId: answered.answer.storeId,
          problem: String(error),
        });
      }

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

    async pause(request: PauseSessionRequest): Promise<PauseOutcome> {
      const asked = await askPause(request, 'session-pause');
      if (!asked.ok) return asked;
      const { registrationId, answer } = asked;
      if (answer.type !== 'session-paused') {
        return answeredWithSomethingElse('pause', registrationId, answer.type);
      }
      logger.info('session pause', { registrationId, ...request, pause: answer.pause });
      return {
        ok: true,
        storeId: answer.storeId,
        sessionId: answer.sessionId,
        server: registrationId,
        pause: answer.pause,
      };
    },

    async resume(request: PauseSessionRequest): Promise<ResumeOutcome> {
      const asked = await askPause(request, 'session-resume');
      if (!asked.ok) return asked;
      const { registrationId, answer } = asked;
      if (answer.type !== 'session-resumed') {
        return answeredWithSomethingElse('resume', registrationId, answer.type);
      }
      logger.info('session resume', { registrationId, ...request });
      return {
        ok: true,
        storeId: answer.storeId,
        sessionId: answer.sessionId,
        server: registrationId,
      };
    },

    async transcript(request: TranscriptRequest): Promise<TranscriptOutcome> {
      // Resolve, check reachable, ask, check the answer's type, return: the
      // shape `docs.open` has, routed by session rather than by directory. The
      // routing does the first two in one step, because for a session the
      // question "which machine" and the question "is it reachable" have one
      // answer.
      const routed = routeSessionRead(state.snapshot(), request);
      if (!routed.ok) {
        logger.info('transcript refused', { ...request, problem: routed.problem });
        return { ok: false, code: routed.code, problem: routed.problem };
      }

      const { registrationId } = routed.server;
      const answered = await connections.ask(registrationId, {
        type: 'session-transcript',
        storeId: request.storeId,
        sessionId: request.sessionId,
        // The hub's own row, not the client's word. A client addresses a
        // session; which agent wrote the file is a fact this hub already holds,
        // and reading it here is what keeps a client from choosing which
        // adapter opens a file on somebody's disk.
        provider: routed.provider,
        count: request.count,
      });

      if (!answered.ok) {
        logger.info('the server refused a transcript', {
          registrationId,
          ...request,
          problem: answered.problem,
        });
        return { ok: false, code: answered.code, problem: answered.problem };
      }

      // Narrowed on the frame that arrived rather than assumed from what was
      // asked, like a start: a peer that answered a transcript with a stop is a
      // peer that is out of step, and drawing its word as a transcript would
      // put an empty history in front of somebody as though it were the truth.
      if (answered.answer.type !== 'session-transcript-read') {
        logger.error('the server answered a transcript with something else', {
          registrationId,
          answered: answered.answer.type,
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'the server answered a transcript read with something else',
        };
      }

      // Relayed, not kept. There is no row written here and no cache: a
      // transcript held by the hub would be a screen showing what a session was
      // doing when somebody last looked.
      return {
        ok: true,
        activities: answered.answer.activities,
        olderExist: answered.answer.olderExist,
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
      outcome.hold === null
        ? null
        : { server: registrationId, stoppable: outcome.hold.stoppable, pause: outcome.hold.pause },
  };
}
