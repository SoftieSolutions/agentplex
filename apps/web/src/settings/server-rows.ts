import type { MachineState, ServerRegistrationId, ServerView } from '@agentplex/protocol';
import type { Tone } from '../ui/tokens.js';

/**
 * The paired-server list, projected from the machine state into exactly what
 * the settings screen draws. The projection is pure and lives outside any
 * component so the mapping from wire fact to screen word is testable without
 * a DOM.
 *
 * What is *not* here is as deliberate as what is. The machine state carries no
 * address — the hub publishes what it can vouch for and where it dials a
 * server is not a fact clients need — and no latency, so neither is drawn;
 * a latency invented client-side would be an over-claim. The pairing token is
 * nowhere near the wire at all, by design.
 */

export interface ServerRowView {
  readonly registrationId: ServerRegistrationId;
  readonly label: string;
  /** What the machine calls itself, once a handshake has said so. */
  readonly serverId: string | null;
  /** The connectivity, as the tone dot beside the row. */
  readonly tone: Tone;
  /** The connectivity, as a word beside the dot. */
  readonly phase: string;
  /** What is wrong, in the hub's words, or `null` while nothing is. */
  readonly problem: string | null;
  /** The stores it had mounted when last connected. */
  readonly stores: readonly string[];
}

/**
 * The tone vocabulary is the mockup's: a connected server runs, an
 * unreachable one is blocked (something is wrong and waiting will not always
 * fix it — the `problem` words say which), and one still being dialled is
 * idle rather than alarming. `stopped` never reaches a client in practice
 * (the reducer forgets a revoked server with its rows), but the phase is one
 * union and this projection covers all of it rather than casting.
 */
function toneFor(view: ServerView): Tone {
  switch (view.phase) {
    case 'connected':
      return 'running';
    case 'connecting':
      return 'idle';
    case 'stale':
      return 'blocked';
    case 'stopped':
      return 'idle';
  }
}

function phaseWords(view: ServerView): string {
  switch (view.phase) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'stale':
      return 'unreachable';
    case 'stopped':
      return 'unpaired';
  }
}

/** Every paired server, in the order the hub publishes them (sorted by label). */
export function serverRows(state: MachineState | null): readonly ServerRowView[] {
  if (state === null) return [];
  return state.servers.map((view) => ({
    registrationId: view.registrationId,
    label: view.label,
    serverId: view.serverId,
    tone: toneFor(view),
    phase: phaseWords(view),
    problem: view.problem,
    stores: view.stores,
  }));
}
