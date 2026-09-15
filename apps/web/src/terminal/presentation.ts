import type { MachineState, SessionRef, SessionRow, SessionStatus } from '@agentplex/protocol';
import type { HubSnapshot } from '../store/hub-store.js';
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
  const registrationId = row.holder?.server ?? row.source;
  const server = state.servers.find((candidate) => candidate.registrationId === registrationId);
  return server?.label ?? registrationId;
}

/**
 * The sentence shown beside the terminal while typing goes nowhere, or
 * `null` while everything typed is going somewhere.
 *
 * Two ways for a keystroke to go nowhere, in words that keep them apart. The
 * store's own notice covers the connection being down — those keystrokes are
 * discarded by contract, never queued. `undelivered` is the pane's most
 * recent refused send on a LIVE connection, which today means the build has
 * no terminal-input frame to put a keystroke on; the store's refusal reason
 * says so, and repeating it here beats a terminal that reads as hung.
 */
export function terminalInputNotice(
  snapshot: HubSnapshot,
  undelivered: string | null,
): string | null {
  if (snapshot.terminalInput.notice !== null) return snapshot.terminalInput.notice;
  if (snapshot.phase === 'connected' && undelivered !== null) {
    return `typing goes nowhere: ${undelivered}`;
  }
  return null;
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
 * A find reaches what this pane holds and nothing further: the emulator keeps
 * a bounded scrollback, and the feed that replayed into it dropped its oldest
 * chunks once it passed its byte cap. Either way the beginning of a long
 * session is gone, and "no matches" over a truncated buffer is a claim about
 * output that was never searched. The bar says the bound out loud instead --
 * the honest direction, since a user who knows the window can go look
 * elsewhere, and a user told "no matches" stops looking.
 */
export function searchScopeNotice(truncated: boolean): string | null {
  if (!truncated) return null;
  return `the last ${String(EMULATOR_SCROLLBACK_LINES)} lines only: earlier output is no longer held here, so a miss is not proof of absence`;
}
