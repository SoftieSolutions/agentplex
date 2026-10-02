import { readinessRefusal } from '@agentplex/protocol';
import type {
  MachineState,
  Provider,
  ServerView,
  SessionDescriptor,
  SessionRow,
  StoreId,
  SubscriptionEndReason,
} from '@agentplex/protocol';
import type { Answer, FollowUp } from '../store/answers.js';
import type { HubCommand } from '../store/commands.js';
import type { ConnectionPhase } from '../store/views.js';
import { canStart, liveServers } from '../sessions/new-session-model.js';
import { serverLabel, toneForSession, wordsForSession } from '../sessions/session-list-model.js';
import type { Tone } from '../ui/tokens.js';
import { machineLabel } from './presentation.js';

/**
 * What a session pane shows in place of a terminal, and whether it resumes
 * the session on its own.
 *
 * A pane used to subscribe to whatever it was pointed at, and a session no
 * process runs answered that with a refusal under a blank rectangle. The
 * session-row facts that say why -- who holds it, whether a process runs it,
 * whether its machine is reachable, what that machine can start -- were all
 * already in the state; this is the one place they are read together, and
 * the order they are read in is the substance.
 *
 * The holder comes first and beats everything, including this pane's own
 * refusal: a pane that was told "already being started" because a second
 * pane got there first is answered by the holder appearing, and has nothing
 * left to say. Then this pane's own start, because a person who pressed
 * Resume is owed what became of that press over anything the row said before
 * it. Then the session ending, which never resumes on its own -- a session
 * somebody just stopped is not one to restart behind their back. Then what
 * the row says about a process, degrading towards not acting: `running` and
 * unheld is somebody else's process, `unknown` is a question only a person
 * can answer, and only `none` is permission to start one.
 */

/** A control the pane offers in place of the terminal, or none. */
export type PaneAction = 'resume' | 'try-again' | null;

export type PaneState =
  /** No row for this session: the terminal it always drew, watching by address. */
  | { readonly kind: 'unknown-row' }
  /** Something in agentplex runs it: the terminal. */
  | { readonly kind: 'held' }
  /**
   * Nothing runs it and it is being resumed. `send` is whether this pane
   * should put the start on the wire now: once, on a live connection, and
   * never again after it has asked.
   */
  | {
      readonly kind: 'starting';
      readonly send: boolean;
      readonly words: string;
      readonly action: null;
    }
  /**
   * The hub said this pane's start went out, and a state since shows nothing
   * running the session: a resume that exited before its machine reported it.
   */
  | {
      readonly kind: 'lapsed';
      readonly machine: string;
      readonly words: string;
      readonly action: 'try-again';
    }
  /** The hub said no to this pane's start; `words` are the hub's own. */
  | { readonly kind: 'refused'; readonly words: string; readonly action: 'try-again' }
  /** This pane's start went out and no answer will ever come for it. */
  | { readonly kind: 'lost'; readonly words: string; readonly action: 'try-again' }
  /** The session ended under this pane, or stopped after it was held. */
  | { readonly kind: 'ended'; readonly words: string; readonly action: 'resume' }
  /** Every machine that reported it is out of reach. */
  | {
      readonly kind: 'unreachable';
      readonly machine: string;
      readonly words: string;
      readonly action: null;
    }
  /** A process runs it that agentplex does not hold. */
  | {
      readonly kind: 'outside';
      readonly machine: string;
      readonly words: string;
      readonly action: null;
    }
  /** Nothing can say whether a process runs it. */
  | {
      readonly kind: 'cannot-tell';
      readonly words: string;
      readonly warning: string;
      readonly action: 'resume';
    }
  /** Nothing connected to the store can start its provider. */
  | {
      readonly kind: 'unsupported';
      readonly provider: Provider;
      readonly words: string;
      readonly reasons: readonly string[];
      readonly action: null;
    };

export interface PaneStateInput {
  readonly row: SessionRow | null;
  readonly state: MachineState | null;
  /**
   * What became of the start this pane sent, or `null` while it has sent none
   * since it last saw the session held.
   */
  readonly start: FollowUp<Answer<'session-started'>> | null;
  /** The watched terminal's ending, when the pane is watching one. */
  readonly terminal: { readonly ended: SubscriptionEndReason | null } | null;
  /** Whether this pane has seen the session held since it opened. */
  readonly everHeld: boolean;
  /** Whether a state since the start was answered still shows nothing running it. */
  readonly startLapsed: boolean;
  readonly phase: ConnectionPhase;
  /**
   * Whether `state` arrived on this connection. Acting on the last
   * connection's word would resume a session on what may no longer be true.
   */
  readonly stateCurrent: boolean;
}

const CANNOT_TELL_WARNING =
  'if another copy is running, resuming puts two processes on one transcript and damages the ' +
  'session for both: resume only if you know nothing else is running it';

export function paneState(input: PaneStateInput): PaneState {
  const { row, state, start, terminal, everHeld, startLapsed, phase, stateCurrent } = input;
  if (row === null) return { kind: 'unknown-row' };
  if (row.holder !== null) return { kind: 'held' };

  if (start !== null) {
    switch (start.kind) {
      case 'waiting':
        return {
          kind: 'starting',
          send: false,
          words: 'nothing was running this session, so it is being resumed',
          action: null,
        };
      case 'answered': {
        const machine =
          state === null ? start.answer.server : serverLabel(state, start.answer.server);
        if (startLapsed) {
          return {
            kind: 'lapsed',
            machine,
            words:
              `this session was resumed on ${machine}, but that machine's next report shows ` +
              'nothing running it: the process may have exited as soon as it started',
            action: 'try-again',
          };
        }
        return {
          kind: 'starting',
          send: false,
          words: `resumed on ${machine}; waiting for that machine to report it running`,
          action: null,
        };
      }
      case 'refused':
        return { kind: 'refused', words: start.words, action: 'try-again' };
      case 'idle':
        return {
          kind: 'lost',
          words:
            'the resume went out but no answer will come for it: the connection it was sent on ' +
            'dropped, so whether it started is unknown until a machine reports it running',
          action: 'try-again',
        };
    }
  }

  const process = row.descriptor.process;
  if (terminal?.ended === 'session-ended' || (everHeld && process === 'none')) {
    return {
      kind: 'ended',
      words: 'this session is no longer running: the process that held it has ended',
      action: 'resume',
    };
  }

  if (!row.reachable) {
    const machine = state === null ? row.source : machineLabel(state, row);
    return {
      kind: 'unreachable',
      machine,
      words:
        `${machine}, the machine that reported this session, cannot be reached: ` +
        'nothing can attach to it or resume it until that machine is back',
      action: null,
    };
  }

  switch (process) {
    case 'running': {
      const machine = state === null ? row.source : machineLabel(state, row);
      return {
        kind: 'outside',
        machine,
        words:
          `this session is running on ${machine}, but not under agentplex: there is no terminal ` +
          'here to attach to, and resuming it would put a second process on its transcript',
        action: null,
      };
    }
    case 'unknown':
      return {
        kind: 'cannot-tell',
        words: 'agentplex cannot tell whether anything is running this session',
        warning: CANNOT_TELL_WARNING,
        action: 'resume',
      };
    case 'none': {
      const { provider, storeId } = row.descriptor;
      if (capableServers(state, storeId, provider).length === 0) {
        return {
          kind: 'unsupported',
          provider,
          words: `nothing connected to this store can run ${provider}, so this session cannot be resumed`,
          reasons: unsupportedReasons(state, storeId, provider),
          action: null,
        };
      }
      return {
        kind: 'starting',
        send: phase === 'connected' && stateCurrent,
        words:
          phase !== 'connected'
            ? 'nothing is running this session; it is resumed once the connection to the hub is back'
            : stateCurrent
              ? 'nothing is running this session, so it is being resumed'
              : 'nothing was running this session when last reported; it is resumed once the hub ' +
                'sends its current state and that still says so',
        action: null,
      };
    }
  }
}

/**
 * The connected machines on a store that say they can start this provider.
 *
 * The new-session form's own two rules, reused rather than restated, because
 * the hub routes a resume by the same `readinessRefusal` and a pane with its
 * own notion of startable would be a second rule free to drift from it.
 */
export function capableServers(
  state: MachineState | null,
  storeId: StoreId,
  provider: Provider,
): readonly ServerView[] {
  return liveServers(state, storeId).filter((view) => canStart(view, provider));
}

/** Why each connected machine on the store cannot start the provider, in its own words. */
function unsupportedReasons(
  state: MachineState | null,
  storeId: StoreId,
  provider: Provider,
): readonly string[] {
  const live = liveServers(state, storeId);
  if (live.length === 0) return ['no machine that mounts this store is connected to the hub'];
  return live.map((view) => {
    if (view.providers.length === 0) {
      return `${view.label} reports no providers: that build carries no provider adapters`;
    }
    const readiness = view.providers.find((entry) => entry.provider === provider);
    if (readiness === undefined) return `${view.label} does not report ${provider}`;
    return `${view.label} cannot run ${provider}: ${readinessRefusal(readiness) ?? 'it did not say why'}`;
  });
}

/**
 * The start that resumes a session: the session named, its own provider, and
 * the placement left to the hub. No prompt -- a resume reopens the agent at its
 * own prompt -- and no project, because the directory is the one its own
 * transcript recorded and the hub refuses a resume that names one.
 */
export function resumeCommand(
  session: Pick<SessionDescriptor, 'storeId' | 'sessionId' | 'provider'>,
): HubCommand {
  return {
    type: 'session-start',
    storeId: session.storeId,
    sessionId: session.sessionId,
    provider: session.provider,
    prompt: null,
    server: null,
    project: null,
  };
}

/** Whether the header should say that nothing is running this row. */
function notRunning(row: SessionRow | null): boolean {
  return row !== null && row.holder === null && row.descriptor.process !== 'running';
}

/**
 * The word beside the header's dot.
 *
 * The list's word, except for a row nothing holds and no process runs: its
 * transcript may say it was waiting for input, and the header over a pane
 * that is about to resume it -- or cannot -- would be claiming an agent at a
 * prompt that nothing is running.
 */
export function headerWords(row: SessionRow | null): string {
  return notRunning(row) ? 'not running' : wordsForSession(row);
}

/** The dot's tone, quiet for the same rows the word says are not running. */
export function headerTone(row: SessionRow | null): Tone {
  return notRunning(row) ? 'idle' : toneForSession(row);
}
