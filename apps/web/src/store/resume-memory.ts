import type { ClientTerminalTarget, FrameId, MachineState, SessionRef } from '@agentplex/protocol';
import type { Reply } from './answers.js';
import type { HubCommand } from './commands.js';

/**
 * What this page has learnt about resuming one session, kept for as long as
 * the page is, by the session and not by the pane looking at it.
 *
 * A pane is not the thing that lasts. Splitting it, closing its sibling, or
 * leaving the layout and coming back mounts it again from nothing, and a pane
 * that kept these facts in its own state would open on a session somebody
 * just stopped as though it had never seen it run -- and restart it. So the
 * facts that stop a pane resuming on its own live here, in the store every
 * pane already reads, and a remounted pane picks them up where the last one
 * left them.
 *
 * By session and not by pane means a second pane on the session reads the
 * first one's facts too, which errs the safe way: what this page saw running,
 * in a pane or in the sidebar, is never restarted behind anybody's back.
 */
export interface ResumeMemory {
  /**
   * Whether this page has seen a process run this session since it loaded:
   * held by agentplex or run outside it in any state received, ended under a
   * pane, or stopped from this page. A session that ran is resumed only by a
   * press.
   */
  readonly ran: boolean;
  /**
   * The last start this page sent for it, until a state shows the session
   * held -- which is that start's answer, and after which an ending is an
   * ending and not "still starting".
   */
  readonly start: FrameId | null;
  /**
   * Whether a state that arrived after the hub answered that start still
   * showed nothing in agentplex holding the session.
   *
   * A server reports a hold only for a live terminal, so a resume that exits
   * before its machine reports again is never seen held, and a pane waiting
   * for the holder would wait for ever with nothing to press. This is the
   * pane's way out. It can be early -- another machine's report can move the
   * state before the starting one's does -- and the holder appearing still
   * beats it, so the cost of early is a button shown for a moment.
   */
  readonly lapsed: boolean;
  /**
   * Whether `start` is a retake: a start that first ends the claude running
   * the session outside agentplex.
   *
   * It is waited for and lapses exactly as a resume does, so it is the same
   * start and not a second tracker. What differs is what a pane offers when
   * it is refused: a resume's refusal is answered by trying the resume again,
   * and a retake's by the retake, on a session an outside process may still
   * be running -- where a resume would put a second process on its
   * transcript.
   */
  readonly retake: boolean;
}

export type ResumeMemories = ReadonlyMap<string, ResumeMemory>;

export const NO_RESUME_MEMORY: ResumeMemory = {
  ran: false,
  start: null,
  lapsed: false,
  retake: false,
};

type Addressed = Pick<SessionRef, 'storeId' | 'sessionId'>;

function keyOf(ref: Addressed): string {
  return JSON.stringify([ref.storeId, ref.sessionId]);
}

export function resumeMemoryOf(memories: ResumeMemories, ref: Addressed): ResumeMemory {
  return memories.get(keyOf(ref)) ?? NO_RESUME_MEMORY;
}

function withMemory(
  memories: ResumeMemories,
  ref: Addressed,
  change: (memory: ResumeMemory) => ResumeMemory,
): ResumeMemories {
  const before = resumeMemoryOf(memories, ref);
  const after = change(before);
  if (
    after.ran === before.ran &&
    after.start === before.start &&
    after.lapsed === before.lapsed &&
    after.retake === before.retake
  ) {
    return memories;
  }
  return new Map(memories).set(keyOf(ref), after);
}

/** The page saw a process run the session. The same memories back when it already knew. */
export function rememberRan(memories: ResumeMemories, ref: Addressed): ResumeMemories {
  return withMemory(memories, ref, (memory) => ({ ...memory, ran: true }));
}

/**
 * What a command this page sent says about a session: a start that names one
 * is that session's start, and a stop is a session somebody here watched run.
 *
 * A retake is that session's start too. It ends in a resume, answered with
 * `session-started` and then by the hold, so it waits for the hold and lapses
 * without one exactly as a start does. It keeps `ran`: the page saw the
 * outside process run the session, which is what made it a retake.
 */
export function rememberCommand(
  memories: ResumeMemories,
  command: HubCommand,
  id: FrameId,
): ResumeMemories {
  switch (command.type) {
    case 'session-start': {
      const { storeId, sessionId } = command;
      if (sessionId === null) return memories;
      return withMemory(memories, { storeId, sessionId }, (memory) => ({
        ...memory,
        start: id,
        lapsed: false,
        retake: false,
      }));
    }
    case 'session-retake':
      return withMemory(memories, command, (memory) => ({
        ...memory,
        start: id,
        lapsed: false,
        retake: true,
      }));
    case 'session-stop':
      return rememberRan(memories, command);
    default:
      return memories;
  }
}

/**
 * A start this page sent that turned out to be this session, remembered as
 * this session's start -- unless the page already knows the session ran, or
 * has a start of its own out for it.
 *
 * A spawn names no session when it is sent, so `rememberCommand` has nothing
 * to file it under, and the pane rebound to the session once the provider
 * named it would otherwise be a pane on a session nothing here started and
 * nothing has seen run -- which it resumes. The agent quitting at its first
 * prompt, before any state showed it held, is exactly that. Filed as this
 * page's start instead, it is answered by the hold or lapses like any other.
 */
export function rememberStarted(
  memories: ResumeMemories,
  ref: Addressed,
  start: FrameId,
): ResumeMemories {
  return withMemory(memories, ref, (memory) =>
    memory.ran || memory.start !== null
      ? memory
      : { ...memory, start, lapsed: false, retake: false },
  );
}

/**
 * The latest state this page received, with the answers it had received when
 * that state arrived: an answer among `replies` came before `state` did.
 */
export interface StateSeen {
  readonly state: MachineState;
  readonly replies: ReadonlyMap<FrameId, Reply>;
}

/** The two facts of a watched terminal `rememberNamed` reads; a `TerminalWatchView` is one. */
export interface NamedWatch {
  readonly target: ClientTerminalTarget;
  readonly session: Addressed | null;
}

/**
 * A spawn this page sent that something has since named, as
 * `rememberStarted`, held to the latest state as `rememberState` would have
 * held it.
 *
 * A socket may carry the state that shows the spawned session's row before
 * whatever names the spawn. That state found no start filed under the row
 * and passed it by, so a start filed by the name afterwards would wait for a
 * holder that state already said was not there -- with nothing to press until
 * another state arrived. Read against `seen`, the start lapses, or is
 * answered by the hold, exactly as it would have had the name come first.
 */
export function rememberSpawned(
  memories: ResumeMemories,
  ref: Addressed,
  start: FrameId,
  seen: StateSeen | null,
): ResumeMemories {
  const filed = rememberStarted(memories, ref, start);
  if (filed === memories || seen === null) return filed;
  return rememberRows(filed, seen.state, seen.replies, ref);
}

/** Every watch by start handle that a terminal frame has since named, as `rememberSpawned`. */
export function rememberNamed(
  memories: ResumeMemories,
  terminals: ReadonlyMap<string, NamedWatch>,
  seen: StateSeen | null,
): ResumeMemories {
  let next = memories;
  for (const view of terminals.values()) {
    if (view.target.by !== 'start' || view.session === null) continue;
    next = rememberSpawned(next, view.session, view.target.startId, seen);
  }
  return next;
}

/**
 * What a state says about every session in it: held or running means it ran,
 * and for a remembered start, held answers it and unheld after the hub said
 * it started means it lapsed.
 *
 * Ran is read off every row, not only the ones a pane is open on. The page saw
 * the session run whether the sidebar or a pane was the thing drawing it, and
 * a pane opened later on one that has since stopped is opened on a session
 * somebody stopped -- not one to restart behind them. Only a session no state
 * since the page loaded has shown running is resumed on its own.
 *
 * Unheld and not "no process": a row on a shared store, or one whose machine
 * could not read its registry, says `unknown` whatever runs it, and one an
 * outside process runs says `running`. Neither is this start's hold, which is
 * the one thing that answers it, so neither keeps a pane waiting for one.
 *
 * `replies` are the answers already received, so an answer among them came
 * before this state did.
 */
export function rememberState(
  memories: ResumeMemories,
  state: MachineState,
  replies: ReadonlyMap<FrameId, Reply>,
): ResumeMemories {
  return rememberRows(memories, state, replies, null);
}

/** `rememberState`, over every row or over only the one `only` addresses. */
function rememberRows(
  memories: ResumeMemories,
  state: MachineState,
  replies: ReadonlyMap<FrameId, Reply>,
  only: Addressed | null,
): ResumeMemories {
  let next = memories;
  for (const store of state.stores) {
    if (only !== null && store.storeId !== only.storeId) continue;
    for (const row of store.sessions) {
      if (only !== null && row.descriptor.sessionId !== only.sessionId) continue;
      const ref = { storeId: store.storeId, sessionId: row.descriptor.sessionId };
      const { start } = resumeMemoryOf(next, ref);
      if (start === null) {
        if (row.holder !== null || row.descriptor.process === 'running') {
          next = rememberRan(next, ref);
        }
        continue;
      }
      if (row.holder !== null) {
        next = withMemory(next, ref, () => NO_RESUME_MEMORY_RAN);
      } else if (replies.get(start)?.type === 'session-started') {
        next = withMemory(next, ref, (memory) => ({ ...memory, lapsed: true }));
      }
    }
  }
  return next;
}

const NO_RESUME_MEMORY_RAN: ResumeMemory = { ran: true, start: null, lapsed: false, retake: false };
