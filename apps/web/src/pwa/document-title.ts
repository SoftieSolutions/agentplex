import type { MachineState } from '@agentplex/protocol';
import { attentionFloorCount, titleFor } from '../sessions/attention-floor.js';
import { listSessions } from '../sessions/session-list-model.js';

/**
 * The browser tab as an ambient surface: the attention floor, spoken in the
 * one place a person sees while looking at something else entirely.
 *
 * Not a component and not an effect. The title belongs to the document and
 * not to any screen -- it has to be right while the session list is unmounted,
 * while a terminal is full-screen, and while the window is in a background tab
 * where React may never render again -- so this subscribes to the store
 * directly, the way `useSyncExternalStore` would, and writes through to the
 * `title` it was handed.
 *
 * Two things this deliberately accepts, both consequences of `main.tsx`
 * starting it once at module scope:
 *
 * - The page is titled during onboarding too. A person who has not finished
 *   pairing has no sessions, so the count is zero and the title is the bare
 *   name; if they do have sessions on a paired machine, a count in the tab is
 *   the truth and there is no reason onboarding should hide it.
 * - The hub store stays connected for the life of the page. Its socket
 *   lifecycle follows subscriber count, and this subscriber never leaves, so
 *   `teardown` never runs. That is the cost of an ambient surface: a title
 *   that only counted while some component was mounted would go stale exactly
 *   when it matters, in a tab nobody is looking at.
 */

/**
 * The slice of the hub store this reads: a snapshot source and a way to be
 * told it changed. Narrow on purpose, so a test hands in an object and not a
 * socket.
 */
export interface TitleSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly machineState: MachineState | null };
}

/**
 * The slice of `Document` this writes: one mutable string. Injected rather
 * than reached for, because a test cannot supply a document and should not
 * have to fight a global one.
 */
export interface TitleTarget {
  title: string;
}

/**
 * Title the page from the fleet until the returned function is called.
 *
 * The count is global -- every machine, narrowed by nothing. A tab strip is
 * not a screen with a machine selector on it, and a title that silently spoke
 * for one machine would be a number that disagrees with the bell beside it.
 *
 * Before the first state arrives `machineState` is `null`, which is "not
 * answered yet" and not "nothing is asking": the title stays the bare name
 * rather than claiming a zero, in the direction that does not over-claim.
 *
 * Teardown restores the title that was there when this started, not the name
 * this module would have chosen. What it owes the page on the way out is the
 * state it found.
 */
export function startDocumentTitle(source: TitleSource, target: TitleTarget): () => void {
  const found = target.title;

  const write = (): void => {
    const state = source.getSnapshot().machineState;
    target.title = titleFor(state === null ? 0 : attentionFloorCount(listSessions(state)));
  };

  const stopListening = source.subscribe(write);
  write();

  return () => {
    stopListening();
    target.title = found;
  };
}
