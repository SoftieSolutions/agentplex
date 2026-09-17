import type { MachineState, SessionRef } from '@agentplex/protocol';
import type { StartView } from '../store/hub-store.js';
import { serverLabel } from '../sessions/session-list-model.js';

/**
 * What a pane waiting on a start knows about it, as pure functions.
 *
 * A pending pane has exactly two questions to answer and they are answered in
 * different places, which is why they are two functions here rather than one
 * state machine. "What do I say" is about the start: the hub answered it, or
 * refused it, or has not answered yet. "What am I, really" is about the
 * session: it exists the moment the provider names it, and the pane stops
 * being pending then, whatever it was saying a moment before.
 *
 * Both are answered per start and never out of a newest-answer slot. The
 * store files what the hub said against the frame that asked (`StartView`),
 * so the correlation is the key of the entry a pane was handed rather than a
 * comparison made here -- a pane cannot read another start's answer, because
 * it was never given one. The alternative anybody reaches for for the session
 * half -- the newest session on that machine, the row that appeared around the
 * right time -- is a guess, and a spawn racing a scan is exactly the case
 * where guessing attaches a pane to somebody else's agent.
 */

/**
 * The slice of a watched terminal this needs: what it turned out to be.
 *
 * Narrower than `TerminalWatchView`, which satisfies it, because the two
 * callers are a pane and the layout store and only one of them has any
 * business with a feed. It is also what keeps the layout store's view of the
 * hub to the one field it reads.
 */
export interface NamedTerminal {
  readonly session: SessionRef | null;
}

/** Which session this start turned out to be, or `null` while it has no name. */
export function pendingSession(
  start: StartView | null,
  terminal: NamedTerminal | null,
): SessionRef | null {
  // A resume: the hub answered the start with the session it was about, so the
  // pane can stop being pending before a single byte has arrived.
  const started = start?.started ?? null;
  if (started !== null && started.sessionId !== null) {
    return { storeId: started.storeId, sessionId: started.sessionId };
  }
  // A spawn: nobody knows the id until the provider writes it, and the first
  // thing that can say so is the terminal the pane is already watching. The
  // store takes it off the hub's own frames -- the subscription's reply, or a
  // chunk that carries both names -- which is the server's reading of its own
  // store report, relayed. Provenance, not proximity.
  return terminal?.session ?? null;
}

/** What the pane says about a start that has not become a session yet. */
export type PendingWords =
  /** Sent, unanswered. The hub has said nothing about it either way. */
  | { readonly kind: 'asking'; readonly words: string }
  /** The hub placed it, and named the machine it went to. */
  | { readonly kind: 'starting'; readonly words: string }
  /** The hub said no, in its own words. */
  | { readonly kind: 'refused'; readonly words: string };

/**
 * The sentence the pane draws while it is still a pending one.
 *
 * The refusal is read first because it is the one answer that ends the wait:
 * a start that was refused is not a slow start, and a pane that went on saying
 * "starting" over a machine that said no would be the blank rectangle this
 * whole surface exists to avoid.
 *
 * The machine is named through this client's own lookup rather than read out
 * of the hub's sentence, for the reason the new-session form names it that
 * way: the reply carries the registration id the hub resolved, and the label
 * beside it on screen everywhere else is the one the machine state holds. A
 * client that pulled the name out of a message would be showing a second
 * spelling of the same machine.
 */
export function pendingWords(start: StartView | null, state: MachineState | null): PendingWords {
  const refusal = start?.refusal ?? null;
  if (refusal !== null) {
    return { kind: 'refused', words: refusal.message };
  }
  const started = start?.started ?? null;
  if (started !== null) {
    const label = state === null ? started.server : serverLabel(state, started.server);
    // The second clause is not decoration: a pane that is already showing a
    // live terminal while every list on the screen still has no row for it
    // looks like a pane that failed to open, and this is the one sentence
    // that says which of the two a person is looking at.
    return {
      kind: 'starting',
      words: `starting on ${label}; this pane becomes the session when the provider names it`,
    };
  }
  return { kind: 'asking', words: 'starting a session' };
}
