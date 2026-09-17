import { assertNever, type ServerRegistrationId } from '@agentplex/protocol';
import type { ProviderRowView, ServerRowView } from '../settings/server-rows.js';

/**
 * What the wizard says about the one machine somebody just paired, as a pure
 * reading of the rows the hub published.
 *
 * The screen this feeds is the end of the first run, and the temptation there
 * is to congratulate: a tick, a machine name, an operating system, a version
 * number. None of those last three are on any frame the hub sends. The server
 * reports its stores and what it can start; it never reports what it is
 * running on or which build it is, so a line saying "macOS 15, agentplex 1.4"
 * would be the wizard inventing the two facts a first-run reader has no way to
 * check and every reason to believe. The type below has no field for either,
 * which is the only way that stays true after somebody adds a line to the JSX.
 *
 * What replaces them is the hub's own dial progress, which is a fact: the hub
 * dials the server, the server dials nothing, and the wizard is watching that
 * dial happen. So the honest waiting state is `dialling`, and the honest
 * ending when it does not work is `unreachable` with the hub's sentence and
 * the next thing to try -- not a spinner over a machine nobody is ever going
 * to reach, which is the state this model exists to refuse to draw.
 *
 * Every state is derived per render from the latest rows. Nothing here
 * remembers that a previous render said `dialling`, because the hub is free to
 * record a pairing and complete the dial inside one broadcast: the wizard then
 * goes straight from `recorded` to `online` and must not sit waiting for a
 * step that already happened off-screen.
 */
export type PairProgress =
  /**
   * The pairing is on file and no row names it yet.
   *
   * The `server-paired` reply carries the registration id, and the whole state
   * that includes the row is a separate broadcast. Between the two the only
   * true sentence is that the hub wrote the pairing down -- claiming a dial
   * had begun would be describing something the hub has not said.
   */
  | { readonly kind: 'recorded' }
  /** The hub has the pairing and is reaching for the machine. */
  | {
      readonly kind: 'dialling';
      readonly label: string;
      readonly address: string;
    }
  /**
   * The machine answered, described by what it actually reported: the stores
   * it has mounted and the providers it can start. A machine whose `claude` is
   * missing is online and refuses every start, and this is the first screen
   * where somebody could see that before their first session vanishes.
   */
  | {
      readonly kind: 'online';
      readonly label: string;
      readonly address: string;
      /** The row's own phase words, so a drain reads as a drain. */
      readonly words: string;
      readonly connectedSince: number | null;
      readonly stores: readonly string[];
      readonly providers: readonly ProviderRowView[];
    }
  /** The dial failed, in the hub's words, with the next thing to try. */
  | {
      readonly kind: 'unreachable';
      readonly label: string;
      readonly address: string;
      /** The hub's own sentence, or `null` when it published none. */
      readonly problem: string | null;
      readonly nextAction: string;
    };

/**
 * The two things worth checking, in the direction the connection actually
 * runs, and the way out.
 *
 * The hub dials the server. Advice to open a port on the hub, or to point the
 * server at the hub, would send a first-run reader to configure the wrong
 * machine -- the single most expensive misreading this product has, because
 * everything about it looks like an agent reporting home. The unpair is named
 * because the other real possibility is a typo in the address, and a wizard
 * that offers no way to undo its one irreversible-looking step is a wizard
 * people close.
 */
const NEXT_ACTION =
  'Check the server is running and its port is reachable from the hub; Settings can unpair it.';

/**
 * The progress for one registration, read off the rows.
 *
 * The switch is over the row's `tone` rather than its `phase`, because tone is
 * the row's connectivity as a closed union and `phase` is the prose beside it
 * (`shutting down, 2 sessions finishing` is a phase word). Switching on the
 * prose would be re-deriving, by string match, a decision `serverRows` already
 * made -- and it could not end in `assertNever`, so a phase added later would
 * fall out of the bottom of the switch in silence. The prose is still carried
 * through to `online`, where the drain is the part worth reading.
 *
 * `needs-you` reaches `online` on purpose: a draining machine is answering the
 * hub, so it is connected, and the wizard saying anything else about a box
 * that is about to stop would be wrong in both directions at once. `idle` is a
 * dial that has not landed. It also covers a `stopped` row, which is a
 * registration the hub has forgotten -- the reducer drops those with their
 * rows, so in practice the id is simply absent and `recorded` answers instead.
 */
export function pairProgress(
  rows: readonly ServerRowView[],
  registrationId: ServerRegistrationId,
): PairProgress {
  const row = rows.find((candidate) => candidate.registrationId === registrationId);
  if (row === undefined) return { kind: 'recorded' };

  switch (row.tone) {
    case 'idle':
      return { kind: 'dialling', label: row.label, address: row.address };
    case 'running':
    case 'needs-you':
      return {
        kind: 'online',
        label: row.label,
        address: row.address,
        words: row.phase,
        connectedSince: row.connectedSince,
        stores: row.stores,
        providers: row.providers,
      };
    case 'blocked':
      return {
        kind: 'unreachable',
        label: row.label,
        address: row.address,
        problem: row.problem,
        nextAction: NEXT_ACTION,
      };
    default:
      return assertNever(row.tone, 'server row tone');
  }
}
