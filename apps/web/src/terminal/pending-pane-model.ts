import type { MachineState, SessionRef, SubscriptionEndReason } from '@agentplex/protocol';
import type { ConnectionPhase, StartView } from '../store/views.js';
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
  // A spawn: nobody knows the id until the provider writes it. The hub says
  // so to the client that started it, off the store report that paired the
  // start with an id, whether or not a terminal is open on it -- which is the
  // only word a pane that never attached will get.
  const named = start?.named ?? null;
  if (named !== null) return named;
  // Failing that, the terminal the pane is already watching. The store takes
  // it off the hub's own frames -- the subscription's reply, or a chunk that
  // carries both names -- which is the server's reading of its own store
  // report, relayed. Provenance, not proximity.
  return terminal?.session ?? null;
}

/**
 * How long after its yes a spawn may go unnamed before this client stops
 * expecting the name: one minute.
 *
 * A provider given a prompt writes its session file on its first turn, which
 * is seconds after the fork; the naming is one store report and one frame after
 * that. A minute is an order of magnitude past the slow end of that and still
 * short enough that a provider which exited before writing anything stops
 * being listed as starting while the person who started it is still looking.
 * Past it, nothing is drawn as starting: whether the start is slow, dead, or
 * waiting for a first message is something this client cannot tell, and a row
 * guessing at it would be a claim the scans may contradict a moment later. If
 * the provider does write an id, the scan lists the session under its own row.
 */
export const NAMING_BOUND_MS = 60_000;

/**
 * Where this client stands when it judges a start: which connection it is on
 * or last was (`HubSnapshot.connection`), whether that connection is still up
 * (`HubSnapshot.phase`), and what its clock reads.
 *
 * The count and the phase answer different halves of one question -- is the
 * socket that carried this start still open -- and neither answers it alone.
 * The count tells a redialled connection from the one before it even when the
 * phase reads `connected` both times; the phase tells a dropped connection
 * from a live one before any welcome is counted, which through a backoff or
 * after a refusal that stops redialling is never.
 *
 * Passed in rather than read, so the functions stay pure and the clock is the
 * caller's injected one -- the same reading as every age drawn beside them.
 */
export interface StartMoment {
  readonly connection: number;
  readonly phase: ConnectionPhase;
  readonly now: number;
}

/**
 * Whether this client can still expect to hear about a start: its answer, or,
 * once placed, its name.
 *
 * Queued is expected, because it goes out on the next connection. Sent is
 * expected only while the connection that carried it is up, because the hub
 * answers and names a start down that socket alone and forgets its handles the
 * moment it closes -- at the drop, not at the next welcome. Placed is expected
 * for `NAMING_BOUND_MS` after the yes and not after. A refusal is the answer it
 * was owed, so nothing more is coming.
 *
 * Says nothing about whether the start became a session; `pendingSession` is
 * that, and a caller asks both.
 */
export function startAwaited(start: StartView, moment: StartMoment): boolean {
  if (start.refusal !== null) return false;
  if (start.sentOn === null) return true;
  if (!onCarrier(start, moment)) return false;
  if (start.started === null) return true;
  return moment.now - start.started.receivedAt < NAMING_BOUND_MS;
}

/** Whether the socket that carried a sent start is the one open now. */
function onCarrier(start: StartView, moment: StartMoment): boolean {
  return start.sentOn === moment.connection && moment.phase === 'connected';
}

/** The slice of a watched terminal `startLive` reads: its name, and whether it is being fed. */
export interface WatchedStart extends NamedTerminal {
  readonly attached: boolean;
  readonly ended: SubscriptionEndReason | null;
}

/**
 * Whether a start that has not become a session is still something this client
 * can draw as live: awaited, or past the bound with its terminal relayed by the
 * hub right now on the connection that carried it.
 *
 * The second half is the case the bound cannot see. A spawn given no prompt
 * writes no session until somebody types into it, and codex, which has no
 * registry to name it from, waits for a first turn; the pane somebody is
 * typing into is live, not a promise. Past the bound with nothing relaying it
 * -- the terminal ended, detached, or was never watched -- or with the
 * connection gone, it is neither, and nothing more about it is coming.
 *
 * One predicate for the start's sidebar row and its address, so the two never
 * disagree: a row dropped while its pane is still live would leave the pane
 * with no way back to it once somebody navigates away, and a row kept for a
 * pane the address no longer draws would open the list.
 */
export function startLive(
  start: StartView,
  terminal: WatchedStart | null,
  moment: StartMoment,
): boolean {
  if (startAwaited(start, moment)) return true;
  return (
    start.refusal === null &&
    onCarrier(start, moment) &&
    terminal !== null &&
    terminal.attached &&
    terminal.ended === null
  );
}

/**
 * Whether a start's address, `#/start/<id>`, draws the panes rather than the
 * list.
 *
 * Yes for a start that became a session, since the panes show that session;
 * yes for a refused one, whose pane says so in the hub's words; yes while the
 * start is live (`startLive`). Otherwise no -- a start whose connection has
 * gone, or past the bound with nothing relaying it, would open a pane that can
 * only say "starting" forever or be refused, so the address falls to the list.
 */
export function startShown(
  start: StartView | null,
  terminal: WatchedStart | null,
  moment: StartMoment,
): boolean {
  if (start === null) return false;
  if (pendingSession(start, terminal) !== null) return true;
  if (start.refusal !== null) return true;
  return startLive(start, terminal, moment);
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
