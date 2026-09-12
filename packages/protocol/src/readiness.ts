import { z } from 'zod';
import { providerSchema } from './identity.js';

/**
 * What one server found out about one provider before anybody asked it to run
 * anything.
 *
 * This exists because of a property of the seam that actually drives a coding
 * agent: on a pty the fork succeeds and the program is resolved on the far side
 * of it, so a provider binary that is not there does not arrive as a refusal a
 * caller can read. It arrives as a session that starts and immediately exits
 * with no output -- the worst available presentation of the failure, and the
 * one the install spec opens with. The one-shot process seam reports that
 * honestly; the pty seam cannot, because at the moment of the spawn the
 * information does not exist yet.
 *
 * So it has to be known beforehand. A server resolves each provider once at
 * startup and carries the answer into the handshake, which is the earliest
 * point at which the hub can hold it, and the hub refuses a start it can
 * already see will not work rather than starting a process that dies.
 *
 * The rule this is an instance of is the one about degrading without
 * over-claiming: a provider that cannot be run costs itself and not the
 * machine. A server whose `claude` is missing still mounts its stores, still
 * reports its sessions, and still starts a `codex` session -- it simply says,
 * in words, which one of its providers is unusable and why.
 */

/**
 * Whether this provider can be started, in one word.
 *
 * Four members, because they are four different things for a person to do, and
 * two of them are things the hub itself acts on:
 *
 * - `ready`: it resolved, it reported a version, and it says it is logged in.
 * - `missing`: no directory on this server's search path holds the program. A
 *   start would be the pty that dies, so the hub refuses it.
 * - `unauthenticated`: the provider itself says it is logged out. Someone has
 *   to run its login; a session started now would sit at a sign-in prompt
 *   rather than doing the work it was asked for.
 * - `unknown`: the program is there and a probe did not answer -- a wrapper in
 *   front of it, a release that stopped printing what the adapter reads, a
 *   probe that timed out. Deliberately *not* refused: the binary resolves, so
 *   the failure this whole mechanism exists to prevent cannot happen, and a hub
 *   that turned "could not tell" into "no" would be over-claiming in the other
 *   direction. The problem is published so a person can see it.
 */
export const providerReadinessStateSchema = z.enum([
  'ready',
  'missing',
  'unauthenticated',
  'unknown',
]);
export type ProviderReadinessState = z.infer<typeof providerReadinessStateSchema>;

export const providerReadinessSchema = z.object({
  provider: providerSchema,
  state: providerReadinessStateSchema,
  /**
   * What the provider says its version is, verbatim, or `null` when it did not
   * say. A string and not a parsed semver: nothing compares these, and what an
   * operator is shown has to be what the program actually printed.
   */
  version: z.string().min(1).nullable(),
  /**
   * The directory the program resolved from, or `null` when nothing holds it.
   *
   * This is the field the spec asks for by name -- "doctor can say which
   * directory each provider came from, which is the question an operator
   * actually asks when the wrong version runs" -- and it is the one fact that
   * cannot be recovered afterwards from a running session.
   */
  directory: z.string().min(1).nullable(),
  /** Why it is not ready, in words, or `null` when it is. Never a path secret. */
  problem: z.string().min(1).nullable(),
});
export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;

/**
 * Why a machine reporting this readiness must not be asked to start that
 * provider, or `null` when it may be.
 *
 * Here, beside the enum, for the reason `checkProtocolVersion` is beside the
 * version: the words only mean something if both ends agree what they mean, and
 * a hub that decided in its own file while a client greyed out a button in
 * another would be two rules that can drift apart. This is the one place
 * `missing` becomes "no".
 *
 * `unknown` is not a refusal, and that is the considered half of this. The
 * program resolved, so the failure the preflight exists to prevent -- a pty that
 * forks into nothing -- cannot happen; what could not be read is a version or a
 * login state. Refusing on that would be turning "could not tell" into "no",
 * which invents a problem rather than reporting one, and would take a working
 * provider offline the first time its vendor renames a subcommand.
 */
export function readinessRefusal(readiness: ProviderReadiness): string | null {
  switch (readiness.state) {
    case 'ready':
    case 'unknown':
      return null;
    case 'missing':
    case 'unauthenticated':
      // The server's own sentence, which names the machine's actual state. The
      // fallback is for a well-formed frame with nothing in the field: still a
      // refusal, because the state said so, and the state is the fact.
      return readiness.problem ?? `that server cannot run ${readiness.provider}`;
  }
}

/**
 * Whether two readings of a machine's providers say the same thing.
 *
 * Here, beside the schema, for the reason `readinessRefusal` is: a reading is
 * only worth re-reporting when it differs from the one the other end already
 * holds, and "differs" has to mean the same thing wherever that question is
 * asked. Every field is compared, including `version`, `directory` and
 * `problem` -- a provider that is still `ready` from a different directory is a
 * different fact about the machine, and it is exactly the fact an operator who
 * has just changed a search path is looking for.
 *
 * Order is part of the comparison rather than something normalised away. A
 * reading is reported in registration order and is produced by one registry, so
 * two readings in different orders came from different builds, and calling
 * those equal would be the one reordering nobody wants hidden.
 */
export function sameReadiness(
  left: readonly ProviderReadiness[],
  right: readonly ProviderReadiness[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((reading, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      reading.provider === other.provider &&
      reading.state === other.state &&
      reading.version === other.version &&
      reading.directory === other.directory &&
      reading.problem === other.problem
    );
  });
}
