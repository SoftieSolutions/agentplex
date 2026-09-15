import type { ServerRegistrationId } from '@agentplex/protocol';
import type { DirectoryOutcome, Projects } from './projects.js';

/**
 * The hub's browse, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-sessions.ts` is one: what a client connection has to get right is what
 * it does with an outcome -- a listing, a refusal naming a machine that is not
 * connected, a hub that broke on its own side -- and each of those is a value
 * this hands back. The relay and the rule are tested where they live, and end
 * to end against a real server over a real handshake. This is for the tests
 * whose subject is the socket.
 */
export interface FakeProjects extends Projects {
  /** Every browse asked for, in order, so a suite can assert on what crossed. */
  readonly listed: readonly { server: ServerRegistrationId; directory: string | null }[];
  /** What every later browse answers with. */
  answerWith(outcome: DirectoryOutcome): void;
}

export interface FakeProjectsOptions {
  readonly outcome?: DirectoryOutcome;
}

export function createFakeProjects(options: FakeProjectsOptions = {}): FakeProjects {
  const listed: { server: ServerRegistrationId; directory: string | null }[] = [];

  let outcome: DirectoryOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake was given no answer',
  };

  return {
    async listDirectory(
      server: ServerRegistrationId,
      directory: string | null,
    ): Promise<DirectoryOutcome> {
      listed.push({ server, directory });
      return outcome;
    },

    answerWith(next: DirectoryOutcome): void {
      outcome = next;
    },

    get listed(): readonly { server: ServerRegistrationId; directory: string | null }[] {
      return listed;
    },
  };
}
