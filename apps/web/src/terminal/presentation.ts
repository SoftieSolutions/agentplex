import type {
  MachineState,
  ServerView,
  SessionRef,
  SessionRow,
  SessionStatus,
  StaleReason,
  SubscriptionEndReason,
} from '@agentplex/protocol';
import { serverLabel } from '../sessions/session-list-model.js';
import type { ConnectionPhase, HubSnapshot, TerminalWatchView } from '../store/hub-store.js';
import type { Tone } from '../ui/tokens.js';
import { EMULATOR_SCROLLBACK_LINES, type SearchResults } from './emulator.js';

/**
 * Pure derivations the session pane renders: which row a route names, what
 * tone a status takes, and the one sentence shown while keystrokes go
 * nowhere. Kept out of the components so the wording and the mappings are
 * testable without a DOM.
 */

/** The status vocabulary as tones. Both awaiting states want a human, loudly. */
export function toneForStatus(status: SessionStatus): Tone {
  switch (status) {
    case 'working':
      return 'running';
    case 'awaiting-permission':
    case 'awaiting-input':
      return 'needs-you';
    case 'idle':
      return 'idle';
    case 'unknown':
      // The adapter said it could not tell; the muted marker over-claims
      // least. The word beside the dot still says 'unknown'.
      return 'idle';
  }
}

/** Finds the routed session in the published state, or `null` honestly. */
export function findSessionRow(state: MachineState | null, ref: SessionRef): SessionRow | null {
  if (state === null) return null;
  for (const store of state.stores) {
    if (store.storeId !== ref.storeId) continue;
    for (const row of store.sessions) {
      if (row.descriptor.sessionId === ref.sessionId) return row;
    }
  }
  return null;
}

/**
 * The machine name for the header's metadata line: the label of the holder
 * (the server running it now) or, unheld, of the server whose reading the row
 * is. Falls back to the raw registration id rather than hiding the fact.
 */
export function machineLabel(state: MachineState, row: SessionRow): string {
  return serverLabel(state, row.holder?.server ?? row.source);
}

/**
 * The sentence shown beside the terminal while typing goes nowhere, or
 * `null` while everything typed is going somewhere.
 *
 * This used to have a third case and no longer does, which is the whole of
 * what changed when the terminal frames landed. A keystroke on a live
 * connection was refused by the store itself — there was no frame to put one
 * on — and the sentence said so. There is a frame now, so a live connection
 * delivers, and the only two ways left for typing to go nowhere are the two
 * below.
 *
 * The store's own notice covers the connection being down: those keystrokes
 * are discarded by contract, never queued, and the count is the store's to
 * word. `problem` is the hub's most recent "no" about THIS terminal, in the
 * hub's own words — a subscribe to a machine that is asleep, a write to a
 * session whose process has gone. It is worth repeating because it is the
 * case a user cannot see for themselves: a terminal that refuses input and a
 * terminal whose agent is simply quiet draw the same rectangle.
 */
export function terminalInputNotice(
  snapshot: HubSnapshot,
  terminal: TerminalWatchView | null,
): string | null {
  if (snapshot.terminalInput.notice !== null) return snapshot.terminalInput.notice;
  if (snapshot.phase !== 'connected') return null;
  const problem = terminal?.problem ?? null;
  if (problem !== null) return `the hub said no: ${problem}`;
  return null;
}

/**
 * The machine a session is running on, as the published state has it.
 *
 * The holder when something is holding it, and otherwise the server whose
 * reading the row is -- the same choice `machineLabel` makes, because they are
 * answering the same question about the same row.
 */
export function machineFor(state: MachineState | null, row: SessionRow | null): ServerView | null {
  if (state === null || row === null) return null;
  const registrationId = row.holder?.server ?? row.source;
  return state.servers.find((server) => server.registrationId === registrationId) ?? null;
}

/**
 * Reasons no amount of waiting changes, as the fleet state names them.
 *
 * The hub goes on dialling all three -- it should notice a re-pairing without
 * being restarted -- but on a floor of a minute, and nothing that happens in
 * that minute helps. The same set the dial loop keeps for the same three, and
 * it is here rather than imported because what it decides here is a sentence
 * rather than a schedule.
 */
const NEEDS_A_PERSON: ReadonlySet<StaleReason> = new Set<StaleReason>([
  'unauthorized',
  'protocol-version',
  'identity-changed',
]);

/**
 * The sentence for a pane nothing is feeding any more, or `null` while
 * something is.
 *
 * The case this whole frame exists for: an agent that has stopped printing and
 * a relay that has stopped relaying are the same still rectangle, and a user
 * looking at one has no way to tell which they are waiting on. Each reason
 * gets its own words because each is a different thing to do -- wait a moment,
 * wait for a machine that is deliberately restarting, or stop waiting.
 *
 * `machine` is the server row for the machine this session is on, when the
 * state has one, and it is what keeps `server-dropped` from promising too
 * much. The frame carries three reasons and not ten, deliberately: a
 * subscription ends for reasons about the connection, and the connection's own
 * vocabulary for why it is down already reaches this client on every
 * `machine-state`. So the words are joined here, where both facts are, rather
 * than by widening a wire enum that a second pull request is already building
 * on -- and a wrong token or a build that disagrees says so instead of telling
 * somebody to wait for a dial that will be refused exactly as it was.
 */
export function terminalFeedNotice(
  terminal: TerminalWatchView | null,
  machine: ServerView | null = null,
): string | null {
  const ended: SubscriptionEndReason | null = terminal?.ended ?? null;
  if (ended === null) return null;
  switch (ended) {
    case 'server-dropped': {
      const reason = machine?.staleReason ?? null;
      if (reason !== null && NEEDS_A_PERSON.has(reason)) {
        const problem = machine?.problem ?? null;
        return (
          'nothing is reaching this pane: the hub cannot connect to the machine running this session, ' +
          `and waiting will not fix it${problem === null ? '' : ` — ${problem}`}`
        );
      }
      return 'the machine running this session stopped answering: nothing is reaching this pane, and the hub is dialling it again';
    }
    case 'server-draining':
      return 'the machine running this session is shutting down: nothing is reaching this pane until it is back, and the hub is waiting the time it asked for';
    case 'session-ended':
      return 'this terminal is gone: the machine that held it no longer has it, so what is above is the last of what it printed';
  }
}

/**
 * The slice of a watched terminal the attachment indicator reads.
 *
 * One field, and `TerminalWatchView` satisfies it, for the reason the pending
 * pane narrows the same view: what the indicator needs is not a feed and not a
 * byte count, and a function that took the whole view would be a function
 * every future field could change the meaning of.
 *
 * It is also where the next fact goes. AGX-247 adds a `session-subscription-
 * ended` frame and an `ended` flag on the store's view -- the hub saying this
 * terminal is over rather than merely unanswered -- and feeding it in is a
 * field here and a branch below, above the `attached` question, since a watch
 * that ended was attached a moment ago and saying "Attached" about it would be
 * the over-claim this whole indicator exists to prevent.
 */
export interface AttachmentTerminal {
  /** Whether the hub has answered this pane's subscription. */
  readonly attached: boolean;
}

/** What the pane says about its own attachment, and how loudly. */
export interface Attachment {
  readonly tone: Tone;
  /** Capitalised: this is a chip in the header, not a sentence in a row. */
  readonly words: string;
}

/**
 * Whether this pane is attached, in one word, from the two facts that decide
 * it: the socket, and the subscription on it.
 *
 * The connection is read first and that ordering is the substance of this
 * function. A watch record keeps `attached` true until the store tears the
 * connection down, so a pane that asked the terminal alone would go on saying
 * "Attached" over a socket that is being redialled -- which is precisely the
 * moment a person is looking at the word to find out why their keystrokes are
 * going nowhere. The route the pane is on says nothing about any of it: an
 * address is where a user pointed, not what a hub answered.
 *
 * `connected` with no answered watch is "Attaching" rather than a failure.
 * There is no socket state in which a subscribe has been sent and refused and
 * nothing is said: a refusal arrives as a `problem` and the pane repeats the
 * hub's own words underneath, which is a better sentence than any word a chip
 * could hold.
 */
export function paneAttachment(
  phase: ConnectionPhase,
  terminal: AttachmentTerminal | null,
): Attachment {
  switch (phase) {
    case 'idle':
      return { tone: 'idle', words: 'Not connected' };
    case 'connecting':
      return { tone: 'idle', words: 'Connecting' };
    case 'reconnecting':
      return { tone: 'blocked', words: 'Reconnecting' };
    case 'failed':
      return { tone: 'blocked', words: 'Dropped' };
    case 'connected':
      return terminal !== null && terminal.attached
        ? { tone: 'running', words: 'Attached' }
        : { tone: 'idle', words: 'Attaching' };
  }
}

/**
 * A count of bytes as a person reads one.
 *
 * Powers of two, because the thing being measured is a buffer and the number
 * beside it is the number its cap was written in. Whole units below a
 * megabyte -- nobody needs a tenth of a kilobyte -- and one decimal above,
 * where the tenth is a real amount of output.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The one label a pane shows about how much of its session it is showing.
 *
 * Three losses can leave a pane short, they happen in three different places,
 * and the protocol refuses to sum them for a reason this repeats: a pane that
 * says "the first 40 MB is gone" and a pane that says "this link is dropping
 * output" are asking for two different things to be done about it, and a pane
 * whose own buffer rolled over is asking for neither. So the label names
 * whichever of them applies, in the order the loss happened -- before this
 * pane attached, on the way here, after it arrived.
 *
 * And the fourth case, which is not a loss at all and is why this function
 * exists rather than a boolean. A pane that silently starts mid-stream and a
 * pane showing a session that has done nothing are the same empty rectangle
 * and opposite facts. `replayChunks === 0` with `droppedBytes === 0` is the
 * hub saying outright that there has been nothing to show, so the pane says
 * that rather than leaving the user to guess which of the two they are
 * looking at.
 *
 * `null` before the subscription is answered: a pane that has not attached is
 * not yet claiming to show anything, and a label about the completeness of
 * nothing would be the over-claim this exists to prevent.
 */
export function terminalScopeNotice(terminal: TerminalWatchView | null): string | null {
  if (terminal === null || !terminal.attached) return null;

  const missing: string[] = [];
  if (terminal.droppedBytes > 0) {
    missing.push(
      `the first ${formatBytes(terminal.droppedBytes)} this session printed was gone before this pane attached`,
    );
  }
  if (terminal.droppedChunks > 0) {
    const chunks = terminal.droppedChunks === 1 ? 'chunk' : 'chunks';
    missing.push(
      `${String(terminal.droppedChunks)} ${chunks} of output did not fit down this connection and were dropped`,
    );
  }
  if (terminal.evicted) {
    missing.push('this pane has since thrown away its own oldest output');
  }

  const said: string[] = [];
  if (missing.length > 0) said.push(`showing less than everything: ${missing.join('; ')}`);
  // Not one of the losses above, and deliberately not phrased as one: a feed
  // that was re-established is showing MORE than once rather than less than
  // everything. The machine's scrollback survived whatever interrupted the
  // subscription, so what was replayed into this pane overlaps what it already
  // had -- and the bytes are kept rather than cleared, because they are what
  // the emulator has painted and clearing them would throw away a screenful of
  // a session to make a label unnecessary.
  if (terminal.resumed) {
    said.push(
      'this feed was re-established and the session replayed what it still held, so output above may appear twice',
    );
  }
  if (said.length > 0) return said.join(' — ');
  if (!terminal.printed && terminal.replayChunks === 0) {
    return 'nothing here yet: this session has printed nothing, and this pane is showing all of it';
  }
  return null;
}

/**
 * Whether the pane is showing less than the whole session, however it came to
 * be -- the same three sources the label above names.
 *
 * The find bar asks this rather than the feed directly, because a bar that
 * only knew about the feed's own eviction would say "no matches" over output
 * the server dropped before this pane ever attached, which is the same claim
 * about output that was never searched.
 */
export function terminalIsPartial(terminal: TerminalWatchView | null): boolean {
  if (terminal === null) return false;
  return terminal.droppedBytes > 0 || terminal.droppedChunks > 0 || terminal.evicted;
}

/**
 * The find bar's count, in the fewest words that are still true.
 *
 * Three states worth keeping apart. Nothing typed is not a result and says
 * nothing at all. A search whose matches are known but which is standing on
 * none of them -- what the addon reports as index -1, the state right after
 * the last match was passed or a query was retyped -- says how many there
 * are and does not invent a position. Anything else is "3 of 12".
 */
export function matchSummary(query: string, results: SearchResults | null): string {
  if (query.length === 0 || results === null) return '';
  if (results.count === 0) return 'no matches';
  if (results.index < 0)
    return `${String(results.count)} ${results.count === 1 ? 'match' : 'matches'}`;
  return `${String(results.index + 1)} of ${String(results.count)}`;
}

/**
 * What the bar has to say about the question it could not answer, or `null`
 * when it answered the whole of it.
 *
 * A find reaches what this pane holds and nothing further, and there are
 * three ways for that to be less than the session -- the terminal evicted its
 * own scrollback before this pane attached, the link here dropped chunks, or
 * this pane's buffer rolled over. `terminalIsPartial` is the one answer for
 * all three, because the bar's problem is the same in each: "no matches" over
 * output that was never searched is a claim about a session rather than about
 * a buffer. The bar says the bound out loud instead -- the honest direction,
 * since a user who knows the window can go look elsewhere, and a user told
 * "no matches" stops looking.
 */
export function searchScopeNotice(truncated: boolean): string | null {
  if (!truncated) return null;
  return `the last ${String(EMULATOR_SCROLLBACK_LINES)} lines this pane received, and not the whole session: earlier output is no longer held here, so a miss is not proof of absence`;
}
