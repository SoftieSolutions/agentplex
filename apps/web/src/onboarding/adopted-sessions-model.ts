import type { MachineState, Provider, ServerRegistrationId, SessionRef } from '@agentplex/protocol';
import { listSessions, orderByActivity, statusWords } from '../sessions/session-list-model.js';

/**
 * What the wizard says a newly paired machine brought with it, as a pure
 * reading of the state the hub already published.
 *
 * Adoption is not a step in this wizard. The server watches its store on disk
 * and reports what is there; by the time the hub has a machine-state frame
 * naming these sessions, they are already the hub's. So this screen is a
 * report and not a form: there is no list of checkboxes to confirm, nothing
 * here returns a selection, and no frame is sent when somebody reads it. A
 * pre-checked list would be asking permission for something that has happened,
 * and an unchecked one would promise an opt-out the protocol does not offer.
 *
 * Read per render from the latest state, never remembered. A session that
 * stops, or a store that goes unreachable while the screen is open, changes
 * what the machine is holding, and a snapshot taken at pairing time would keep
 * describing the moment it was taken.
 */
export interface AdoptedSession {
  readonly ref: SessionRef;
  /** The provider's title for the session, or the id when it names none. */
  readonly name: string;
  /**
   * Never absent: `provider` is on the descriptor from day one, so a report
   * of what was found can always say which agent wrote it.
   */
  readonly provider: Provider;
  /**
   * The working directory, or `null` when the provider recorded none. Passed
   * through as `null` rather than replaced with the activity words the card
   * list falls back to: this report has a column for the activity already, and
   * filling the directory in from it would claim a path nobody recorded.
   */
  readonly cwd: string | null;
  /** The status in words, the same vocabulary the session list uses. */
  readonly activity: string;
  readonly updatedAt: number;
}

/**
 * The sessions attributed to one machine, last activity first.
 *
 * A state of `null` is a hub that has broadcast nothing yet, and reads as
 * nothing found: the same null `serverRows` and `discoveredCandidates` take,
 * so every projection the wizard holds takes the snapshot as it comes rather
 * than making each screen branch on it.
 *
 * Attribution is `listSessions`' own, not a second copy of it: a session
 * counts for the machine whose reading it is (`server`) or for the machine
 * running it (`holder`). The two differ for a volume two machines have
 * mounted, where the hub picks one reading -- so a session already on screen
 * under another machine's name is not also reported as something this pairing
 * found, and a session this machine is running is reported even when another
 * machine is the one that read it.
 */
export function sessionsOnServer(
  state: MachineState | null,
  registrationId: ServerRegistrationId,
): readonly AdoptedSession[] {
  if (state === null) return [];
  const mine = listSessions(state).filter(
    (item) => item.server === registrationId || item.holder?.server === registrationId,
  );
  return orderByActivity(mine).map((item) => ({
    ref: item.ref,
    name: item.name,
    provider: item.provider,
    cwd: item.cwd,
    activity: statusWords(item.status),
    updatedAt: item.updatedAt,
  }));
}
