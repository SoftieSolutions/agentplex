import type { MachineState, SessionRef, SessionRow, SessionStatus } from '@agentplex/protocol';
import type { HubSnapshot } from '../store/hub-store.js';
import type { Tone } from '../ui/tokens.js';

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
