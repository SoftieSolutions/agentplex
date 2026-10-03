import type { FrameId, MachineState, SessionRef } from '@agentplex/protocol';
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
}

export type ResumeMemories = ReadonlyMap<string, ResumeMemory>;

export const NO_RESUME_MEMORY: ResumeMemory = { ran: false, start: null, lapsed: false };

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
  if (after.ran === before.ran && after.start === before.start && after.lapsed === before.lapsed) {
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
      }));
    }
    case 'session-stop':
      return rememberRan(memories, command);
    default:
      return memories;
  }
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
  let next = memories;
  for (const store of state.stores) {
    for (const row of store.sessions) {
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

const NO_RESUME_MEMORY_RAN: ResumeMemory = { ran: true, start: null, lapsed: false };
