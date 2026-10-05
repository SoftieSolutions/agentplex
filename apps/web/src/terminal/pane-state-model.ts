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
import { followUp, type Answer, type Answers, type FollowUp } from '../store/answers.js';
import type { HubCommand } from '../store/commands.js';
import type { ResumeMemory } from '../store/resume-memory.js';
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
 * left to say. Then this pane's own start while it is still in flight -- owed
 * its answer, or answered and not lapsed -- because a person who pressed
 * Resume is owed what became of that press over anything the row said before
 * it. Then, with nothing of this pane's in flight, a reachable row that reads
 * a process running that agentplex does not hold: that is somebody else's
 * process, offered for a retake, whatever this pane's last start came to and
 * whatever ended before -- a refusal, a lost start, a lapse or an ending is
 * history once a claude runs the session in somebody's own terminal, and the
 * Resume or Try again each of them offers would be a second process on its
 * transcript. Then what became of this pane's last start. Then the session
 * ending, which never resumes on its own -- a session somebody just stopped
 * is not one to restart behind their back. That covers every session this
 * page has seen run since it loaded, held or not, in a pane or only in the
 * sidebar: a pane resumes on its own only a session no state has shown held
 * or running the whole time, and one that stopped at any point before or
 * while it watched -- somebody quitting their own claude in another terminal
 * -- is said to have stopped, with Resume to press. Then what the row says
 * about a process, degrading towards not acting: `unknown` is a question only
 * a person can answer, and only `none` is permission to start one.
 *
 * A retake -- ending the claude somebody runs outside agentplex, at its
 * prompt, and resuming the session here -- is this page's start too, filed in
 * the same resume memory and read in the same place: a retake owed its answer
 * beats the ending, because the moment between the outside process going and
 * the new one being held is one where nothing runs the session, and a pane
 * that has seen it run would call that a session somebody stopped. A retake
 * the hub refused is only words on the offer: what the row says next decides
 * whether there is still an outside process to offer it for.
 *
 * A start of either kind that lapsed hands the decision back to the row as
 * well: a lapse is a fact about the process this page started, not about what
 * runs the session now.
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
   * The hub said this page's start went out, and a state since shows nothing
   * in agentplex holding the session: a resume, or a spawn rebound once named,
   * that exited before its machine reported it held.
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
  /** The session ended under this pane, or stopped after a pane saw it run. */
  | { readonly kind: 'ended'; readonly words: string; readonly action: 'resume' }
  /** Every machine that reported it is out of reach. */
  | {
      readonly kind: 'unreachable';
      readonly machine: string;
      readonly words: string;
      readonly action: null;
    }
  /**
   * A process runs it that agentplex does not hold. `retake` is the offer to
   * end that process and run the session here, and `retakeLabel` the words on
   * its button.
   */
  | {
      readonly kind: 'outside';
      readonly machine: string;
      readonly words: string;
      readonly action: null;
      readonly retake: RetakeOffer;
      readonly retakeLabel: string;
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

/**
 * Where the offer to take over an outside session stands.
 *
 * Disabled while the outside claude is working, by Robert's rule that a retake
 * happens only at idle or waiting: ending a claude mid-turn loses that turn.
 * The machine and the hub check again before anything is signalled, so the
 * row's word is a courtesy and not the guard -- a `shell` session reads as not
 * working here, is offered, and comes back refused in the server's words.
 */
export type RetakeOffer =
  | { readonly kind: 'available' }
  | { readonly kind: 'working-elsewhere'; readonly words: string }
  | { readonly kind: 'retaking' }
  /** The last retake was refused; `words` are the refusing side's own, and it can be pressed again. */
  | { readonly kind: 'refused'; readonly words: string };

export interface PaneStateInput {
  readonly row: SessionRow | null;
  readonly state: MachineState | null;
  /**
   * What became of the start this pane sent, or `null` while it has sent none
   * since it last saw the session held.
   */
  readonly start: FollowUp<Answer<'session-started'>> | null;
  /**
   * What became of the retake this pane sent, or `null` while the start in
   * resume memory is not one. A retake is answered as a start is.
   */
  readonly retake: FollowUp<Answer<'session-started'>> | null;
  /** The watched terminal's ending, when the pane is watching one. */
  readonly terminal: { readonly ended: SubscriptionEndReason | null } | null;
  /**
   * Whether this page has seen a process run the session since it loaded:
   * held by agentplex or run outside it in any state, ended under a pane, or
   * stopped from here.
   */
  readonly ran: boolean;
  /** Whether a state since the start was answered still shows nothing running it. */
  readonly startLapsed: boolean;
  readonly phase: ConnectionPhase;
  /**
   * Whether `state` arrived on this connection. Acting on the last
   * connection's word would resume a session on what may no longer be true.
   */
  readonly stateCurrent: boolean;
}

const CANNOT_TELL: PaneState = {
  kind: 'cannot-tell',
  words: 'agentplex cannot tell whether anything is running this session',
  warning:
    'if another copy is running, resuming puts two processes on one transcript and damages the ' +
    'session for both: resume only if you know nothing else is running it',
  action: 'resume',
};

export function paneState(input: PaneStateInput): PaneState {
  const { row, state, start, retake, terminal, ran, startLapsed, phase, stateCurrent } = input;
  if (row === null) return { kind: 'unknown-row' };
  if (row.holder !== null) return { kind: 'held' };

  // A start or retake this pane sent that has not come to anything yet --
  // owed its answer, or answered and not lapsed -- is owed to whoever
  // pressed, over anything the row said before it.
  if (retake?.kind === 'waiting') return retakeOwed(row, state);
  if (retake?.kind === 'answered' && !startLapsed) return awaitingHold(retake.answer, state);
  if (start?.kind === 'waiting') {
    return {
      kind: 'starting',
      send: false,
      words: 'nothing was running this session, so it is being resumed',
      action: null,
    };
  }
  if (start?.kind === 'answered' && !startLapsed) return awaitingHold(start.answer, state);

  // Nothing of this pane's is in flight, so a process outside agentplex
  // running it now beats whatever this pane's last start came to and
  // whatever ended before: Resume or Try again over it is a second process.
  const process = row.descriptor.process;
  const retakeRefusal = retake?.kind === 'refused' ? retake.words : null;
  if (row.reachable && process === 'running') return runningOutside(row, state, retakeRefusal);

  if (retake?.kind === 'answered') return afterLapse(row, state, retake.answer, 'retake');
  if (start !== null) {
    switch (start.kind) {
      case 'answered':
        return afterLapse(row, state, start.answer, 'resume');
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

  if (terminal?.ended === 'session-ended' || (ran && process === 'none')) {
    return {
      kind: 'ended',
      words:
        'this session stopped: the process that ran it has ended, and nothing is running it now',
      action: 'resume',
    };
  }

  if (!row.reachable) return unreachable(row, state);

  switch (process) {
    case 'running':
      return runningOutside(row, state, retakeRefusal);
    case 'unknown':
      return CANNOT_TELL;
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
 * A retake owed its answer, said in what the row can vouch for.
 *
 * Only a reachable row that says nothing runs it says the outside process
 * stopped. A machine out of reach reported last before the retake could do
 * anything, and a row that cannot tell cannot tell either way: neither is
 * word that the process the retake was sent to end has ended.
 */
function retakeOwed(row: SessionRow, state: MachineState | null): PaneState {
  const machine = state === null ? row.source : machineLabel(state, row);
  const { provider, process } = row.descriptor;
  let words: string;
  if (!row.reachable) {
    words =
      `${machine}, the machine the retake went to, cannot be reached: what became of the ` +
      `${provider} running this session there is unknown until that machine reports again`;
  } else if (process === 'running') {
    return outside(row, state, { kind: 'retaking' });
  } else if (process === 'unknown') {
    words =
      `the retake went to ${machine} and is owed its answer; agentplex cannot tell whether ` +
      'anything is running this session until that answer comes';
  } else {
    words =
      `the ${provider} that was running this session on ${machine} has stopped; it is being ` +
      'started here';
  }
  return { kind: 'starting', send: false, words, action: null };
}

/** A start the hub answered, waiting for its machine to report it held. */
function awaitingHold(answer: Answer<'session-started'>, state: MachineState | null): PaneState {
  const machine = state === null ? answer.server : serverLabel(state, answer.server);
  return {
    kind: 'starting',
    send: false,
    words: `started on ${machine}; waiting for that machine to report it running`,
    action: null,
  };
}

/**
 * A start the hub answered that a later state showed nothing in agentplex
 * holding: what the row says now decides, not the start.
 *
 * The lapse says only that the process this page started is not held. It
 * says nothing about what runs the session since, and the way out a lapse
 * offers is a resume -- over a claude somebody has since run in their own
 * terminal, that is a second process on one transcript. So a row an outside
 * process runs is offered the retake, one nothing can tell about carries the
 * warning, and one out of reach offers nothing. Only a row that says nothing
 * runs it is the lapse itself: a resume is offered to try again, and a retake
 * -- whose outside process is gone too -- is a session that stopped, to
 * resume, because trying a retake again has nothing left to end.
 *
 * `paneState` reads a reachable row's outside process before any lapse, so
 * the running case here is that same rule, kept so the lapse is whole alone.
 */
function afterLapse(
  row: SessionRow,
  state: MachineState | null,
  answer: Answer<'session-started'>,
  was: 'resume' | 'retake',
): PaneState {
  if (!row.reachable) return unreachable(row, state);
  switch (row.descriptor.process) {
    case 'running':
      return runningOutside(row, state, null);
    case 'unknown':
      return CANNOT_TELL;
    case 'none': {
      const machine = state === null ? answer.server : serverLabel(state, answer.server);
      const words =
        `this session was started on ${machine}, but that machine's next report shows ` +
        'nothing in agentplex running it: the process may have exited as soon as it started';
      return was === 'retake'
        ? { kind: 'ended', words, action: 'resume' }
        : { kind: 'lapsed', machine, words, action: 'try-again' };
    }
  }
}

/** A session whose machine is out of reach: nothing to attach to and nothing to press. */
function unreachable(row: SessionRow, state: MachineState | null): PaneState {
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

/**
 * A session a process outside agentplex runs, offered for a retake unless that
 * process is working; `refusal` is the last retake's refusal, if one was.
 */
function runningOutside(
  row: SessionRow,
  state: MachineState | null,
  refusal: string | null,
): PaneState {
  if (row.descriptor.status === 'working') {
    const machine = state === null ? row.source : machineLabel(state, row);
    return outside(row, state, {
      kind: 'working-elsewhere',
      words:
        `the ${row.descriptor.provider} on ${machine} is working: it can be stopped and this ` +
        'session run here once it is waiting at its prompt',
    });
  }
  return outside(
    row,
    state,
    refusal === null ? { kind: 'available' } : { kind: 'refused', words: refusal },
  );
}

/** A session a process outside agentplex runs, with where the offer to take it over stands. */
function outside(row: SessionRow, state: MachineState | null, retake: RetakeOffer): PaneState {
  const machine = state === null ? row.source : machineLabel(state, row);
  return {
    kind: 'outside',
    machine,
    words:
      `this session is running on ${machine}, but not under agentplex: there is no terminal ` +
      'here to attach to, and resuming it would put a second process on its transcript',
    action: null,
    retake,
    retakeLabel:
      retake.kind === 'retaking'
        ? 'stopping it, then starting here'
        : `Stop the ${row.descriptor.provider} on ${machine} and run this session here`,
  };
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

/**
 * The take-over of a session run outside agentplex: the session named and
 * nothing else. The hub finds the machine that sees the process and reads the
 * provider off its own row; the machine finds the process.
 */
export function retakeCommand(
  session: Pick<SessionDescriptor, 'storeId' | 'sessionId'>,
): HubCommand {
  return { type: 'session-retake', storeId: session.storeId, sessionId: session.sessionId };
}

/** What became of this page's start of a session, when that start was a resume. */
export function resumeFollowUp(
  memory: ResumeMemory,
  answers: Answers,
): FollowUp<Answer<'session-started'>> | null {
  if (memory.start === null || memory.retake) return null;
  return followUp(memory.start, answers, 'session-started');
}

/** What became of this page's start of a session, when that start was a retake. */
export function retakeFollowUp(
  memory: ResumeMemory,
  answers: Answers,
): FollowUp<Answer<'session-started'>> | null {
  if (memory.start === null || !memory.retake) return null;
  return followUp(memory.start, answers, 'session-started');
}

/**
 * Whether this page has a retake of the session out that has not come to
 * anything yet: owed its answer, or answered and waiting for the hold.
 *
 * What a press of the offer reads from the store as it is now, rather than
 * the render's copy, so a second pane pressed before it drew the first one's
 * retake sends nothing.
 */
export function retakeOutstanding(memory: ResumeMemory, answers: Answers): boolean {
  const retake = retakeFollowUp(memory, answers);
  if (retake === null) return false;
  return retake.kind === 'waiting' || (retake.kind === 'answered' && !memory.lapsed);
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
