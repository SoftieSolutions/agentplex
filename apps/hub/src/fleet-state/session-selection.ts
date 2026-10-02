import type { ServerRegistrationId, SessionDescriptor } from '@agentplex/protocol';

/**
 * Which server's reading of a session the hub shows.
 *
 * A session's identity is `{ storeId, sessionId }` and never the machine, so
 * two servers with the same volume mounted report the same sessions. They are
 * not copies to be reconciled: they are two readings of one thing, taken at
 * different moments through different machines, and the hub's job is to pick
 * the reading it trusts most and show that one.
 *
 * Picking, not merging, is the whole point. A row assembled out of one
 * server's status and another's title describes a session that never existed
 * anywhere, and no later reading can undo it because there is nothing to
 * compare it against. Whatever this returns, it returns whole.
 */

/** One server's reading of one session, with what the hub knows about the reader. */
export interface ReportedSession {
  readonly registrationId: ServerRegistrationId;
  /**
   * Exactly what that server said, unmodified. The row built from the chosen
   * reading may lower its `process` (see `buildSessionRows`); the choice is
   * made on what the server said.
   */
  readonly descriptor: SessionDescriptor;
  /** When the report carrying this reading arrived. */
  readonly reportedAt: number;
  /** Whether the hub is holding a connection to the server that said it. */
  readonly reachable: boolean;
}

/**
 * Whether the server that made this reading saw a live process on it.
 *
 * `running` is a sighting: a terminal that server spawned, or a registry
 * entry it verified against its own process table. Status is not, because it
 * is read out of the transcript every server on the volume can read, and a
 * session idle at a prompt still has its process alive.
 */
function sawAProcess(reading: ReportedSession): boolean {
  return reading.descriptor.process === 'running';
}

/**
 * The better of two readings, in the order the reasons actually rank.
 *
 * 1. Reachable first. A reading through a machine nobody can reach cannot be
 *    acted on -- the session cannot be opened, answered, or stopped -- and a
 *    fresher reading of an unanswerable session is still unanswerable.
 * 2. Then the later reading of the transcript, by the provider's own
 *    timestamp. A server whose watch is behind is reporting the past, and
 *    `updatedAt` is what says so; the filesystem's mtime would not survive the
 *    volume being copied.
 * 3. Then the server that could see a process. This is below freshness on
 *    purpose: if the other server has read past the moment the process exited,
 *    keeping `running` would leave a spinner on a session that has finished.
 * 4. Then the registration id, so that a genuine tie resolves the same way on
 *    every snapshot rather than flickering between two machines that agree.
 */
function isBetter(candidate: ReportedSession, incumbent: ReportedSession): boolean {
  if (candidate.reachable !== incumbent.reachable) return candidate.reachable;

  const { updatedAt: candidateAt } = candidate.descriptor;
  const { updatedAt: incumbentAt } = incumbent.descriptor;
  if (candidateAt !== incumbentAt) return candidateAt > incumbentAt;

  const candidateSaw = sawAProcess(candidate);
  if (candidateSaw !== sawAProcess(incumbent)) return candidateSaw;

  return candidate.registrationId < incumbent.registrationId;
}

/**
 * The reading to show, taken whole.
 *
 * Throws on an empty list rather than answering with a gap: a session is in
 * the hub's state because some server reported it, so having none of its
 * readings left is the caller having lost track of one, not a session with
 * nothing known about it.
 */
export function chooseReportedSession(readings: readonly ReportedSession[]): ReportedSession {
  const [first, ...rest] = readings;
  if (first === undefined) throw new Error('cannot choose a session row from no readings');

  let best = first;
  for (const reading of rest) {
    if (isBetter(reading, best)) best = reading;
  }
  return best;
}
