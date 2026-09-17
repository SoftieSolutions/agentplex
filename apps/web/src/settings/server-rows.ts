import type {
  MachineState,
  ProviderReadiness,
  ServerDraining,
  ServerRegistrationId,
  ServerView,
  StaleReason,
} from '@agentplex/protocol';
import type { ProviderRowView } from '../ui/provider-line.js';
import type { Tone } from '../ui/tokens.js';

/**
 * The paired-server list, projected from the machine state into exactly what
 * the settings screen draws. The projection is pure and lives outside any
 * component so the mapping from wire fact to screen word is testable without
 * a DOM.
 *
 * What is *not* here is as deliberate as what is. There is no latency, because
 * the machine state carries none: only the end that dialled can time a round
 * trip, the hub does not yet measure one, and a figure invented client-side
 * would be an over-claim about how far away a machine is. The pairing token is
 * nowhere near the wire at all, by design — it travels once, inbound, on the
 * frame that pairs a server.
 *
 * The address is drawn, and it is the one thing on this row the user typed.
 * Two machines a person labelled `gpu-box` are one row twice without it, and
 * the button beside it revokes a token rather than hiding a row.
 */

export interface ServerRowView {
  readonly registrationId: ServerRegistrationId;
  readonly label: string;
  /** What the machine calls itself, once a handshake has said so. */
  readonly serverId: string | null;
  /** Where this hub dials it. Never a credential: the parser forbids one. */
  readonly address: string;
  /** The connectivity, as the tone dot beside the row. */
  readonly tone: Tone;
  /** The connectivity, as a word beside the dot. */
  readonly phase: string;
  /** What is wrong, in the hub's words, or `null` while nothing is. */
  readonly problem: string | null;
  /**
   * Why the connection went stale, or `null` while none has -- and `null` too
   * when the hub named no reason for one that did.
   *
   * It rides beside `problem` rather than inside it because the two are for
   * different readers. `problem` is the hub's sentence, for a person; this is
   * the hub's closed union, for a screen deciding what to offer next. A
   * refused token and an unreachable port are the same red row and opposite
   * instructions, and a client that told them apart by matching on the prose
   * would be parsing English to recover something the frame already said.
   */
  readonly staleReason: StaleReason | null;
  /**
   * When the connection now held was established, or `null` when none is.
   *
   * The hub stamped this with its own clock, which is why it is the one instant
   * on the row worth drawing: a machine's own idea of when it connected is a
   * reading from a clock that disagrees with the hub's, and the phase words
   * beside it say nothing about whether this connection is four seconds or four
   * days old -- the difference between a box that is up and one that is
   * flapping.
   *
   * Carried as the moment rather than as "up 4 minutes", because a duration
   * computed here is computed once. This projection runs when a frame arrives,
   * not on a tick, so a rendered age would freeze at the last frame and read as
   * a machine that stopped ageing. Turning it into words is the drawing's job,
   * where the clock that ticks lives.
   */
  readonly connectedSince: number | null;
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

/**
 * The tone vocabulary is the mockup's: a connected server runs, an
 * unreachable one is blocked (something is wrong and waiting will not always
 * fix it — the `problem` words say which), and one still being dialled is
 * idle rather than alarming. `stopped` never reaches a client in practice
 * (the reducer forgets a revoked server with its rows), but the phase is one
 * union and this projection covers all of it rather than casting.
 *
 * A machine that is shutting down is the one row that is not read off the
 * phase alone. The connection is up and answering, so `blocked` would be a
 * lie about now; `running` would be a lie about the next few seconds. It is
 * `needs-you` — nothing is wrong, and everything on that box is about to stop,
 * which is the one row on this screen somebody should look at.
 */
function toneFor(view: ServerView): Tone {
  switch (view.phase) {
    case 'connected':
      return view.draining === null ? 'running' : 'needs-you';
    case 'connecting':
      return 'idle';
    case 'stale':
      return 'blocked';
    case 'stopped':
      return 'idle';
  }
}

/**
 * The connectivity as a word, and the drain as a short sentence.
 *
 * A draining machine gets a count because the count is the thing a person is
 * deciding on: "shutting down" is a machine to leave alone, and "shutting
 * down, 2 sessions finishing" is two agents somebody may want to look at
 * before they close. After the close the word is `shut down` rather than
 * `unreachable` — the same distinction the stale reason carries, which is the
 * whole point of having told the hub in advance.
 */
function phaseWords(view: ServerView): string {
  switch (view.phase) {
    case 'connected':
      return view.draining === null ? 'connected' : drainingWords(view.draining);
    case 'connecting':
      return 'connecting';
    case 'stale':
      return view.staleReason === 'draining' ? 'shut down' : 'unreachable';
    case 'stopped':
      return 'unpaired';
  }
}

function drainingWords(draining: ServerDraining): string {
  const held = draining.sessions.length;
  if (held === 0) return 'shutting down';
  return `shutting down, ${String(held)} ${held === 1 ? 'session' : 'sessions'} finishing`;
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
    address: view.address,
    tone: toneFor(view),
    phase: phaseWords(view),
    problem: view.problem,
    staleReason: view.staleReason,
    connectedSince: view.connectedSince,
    stores: view.stores,
    providers: view.providers.map(providerRow),
  }));
}
