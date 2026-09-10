import type {
  MachineState,
  ProviderReadiness,
  ServerRegistrationId,
  ServerView,
} from '@agentplex/protocol';
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
  /**
   * What that machine can start, one line per provider.
   *
   * Drawn rather than summarised into "ready" or hidden behind a healthy row,
   * because the failure this exists for is invisible everywhere else: a machine
   * whose `claude` is missing is connected, has its stores, lists its sessions,
   * and refuses every start. Before this the only symptom was a session that
   * appeared and vanished, with nothing on any screen pointing at the cause.
   */
  readonly providers: readonly ProviderRowView[];
}

export interface ProviderRowView {
  readonly name: string;
  readonly tone: Tone;
  /** The provider and what it is, as one short line: `claude 2.1.259`. */
  readonly words: string;
  /** The machine's own sentence about what is wrong, or `null`. */
  readonly problem: string | null;
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

/**
 * A provider's readiness as a tone.
 *
 * `unknown` is deliberately not blocked. The binary resolved, so sessions still
 * start; what could not be read is a version or a login state, and painting
 * that red would send somebody to fix a machine that is working. It is not
 * `running` either, because something there is worth a look -- which is exactly
 * what `needs-you` says.
 */
function toneForProvider(readiness: ProviderReadiness): Tone {
  switch (readiness.state) {
    case 'ready':
      return 'running';
    case 'unknown':
      return 'needs-you';
    case 'missing':
    case 'unauthenticated':
      return 'blocked';
  }
}

/**
 * The provider and what it turned out to be, in as few words as say it.
 *
 * A ready provider is named with its version, because that is the fact worth
 * having when one is drawn: which one is actually going to run. Anything else
 * is named with its state, and the machine's own sentence sits underneath.
 */
function providerRow(readiness: ProviderReadiness): ProviderRowView {
  return {
    name: readiness.provider,
    tone: toneForProvider(readiness),
    words:
      readiness.state === 'ready' && readiness.version !== null
        ? `${readiness.provider} ${readiness.version}`
        : `${readiness.provider} ${readiness.state}`,
    problem: readiness.problem,
  };
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
    providers: view.providers.map(providerRow),
  }));
}
