import type { FrameId, MachineState, SessionRef } from '@agentplex/protocol';
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
 * first one's facts too, which errs the safe way: what any pane on this page
 * saw running is never restarted behind anybody's back by another.
 */
export interface ResumeMemory {
  /**
   * Whether a process was seen running this session: held by agentplex, run
   * outside it, ended under a pane, or stopped from this page. A session that
   * ran is resumed only by a press.
   */
  readonly ran: boolean;
  /**
   * The last start this page sent for it, until a state shows the session
   * held -- which is that start's answer, and after which an ending is an
   * ending and not "still starting".
   */
  readonly start: FrameId | null;
}

export type ResumeMemories = ReadonlyMap<string, ResumeMemory>;

export const NO_RESUME_MEMORY: ResumeMemory = { ran: false, start: null };

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
  if (after.ran === before.ran && after.start === before.start) return memories;
  return new Map(memories).set(keyOf(ref), after);
}

/** A pane saw a process run the session. The same memories back when it already knew. */
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
      return withMemory(memories, { storeId, sessionId }, (memory) => ({ ...memory, start: id }));
    }
    case 'session-stop':
      return rememberRan(memories, command);
    default:
      return memories;
  }
}

/** A state that shows a remembered start's session held answers that start. */
export function rememberState(memories: ResumeMemories, state: MachineState): ResumeMemories {
  let next = memories;
  for (const store of state.stores) {
    for (const row of store.sessions) {
      if (row.holder === null) continue;
      const ref = { storeId: store.storeId, sessionId: row.descriptor.sessionId };
      if (resumeMemoryOf(next, ref).start === null) continue;
      next = withMemory(next, ref, () => ({ ran: true, start: null }));
    }
  }
  return next;
}
