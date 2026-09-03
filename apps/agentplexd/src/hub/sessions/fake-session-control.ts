import type {
  SessionControl,
  SessionOutcome,
  StartSessionRequest,
  StopSessionRequest,
} from './session-control.js';

/**
 * The hub's session control, driven by hand.
 *
 * A real implementation of the seam rather than a mock, because what a client
 * connection has to get right is what it does with an outcome: an answer that
 * names where a session landed, a refusal that names a holder, a hub that broke
 * on its own side. Each of those is a value this hands back.
 *
 * The routing and the instruction are tested where they live -- against real
 * reduced state and, end to end, against a real server over a real handshake.
 * This is for the tests whose subject is the socket.
 */
export interface FakeSessionControl extends SessionControl {
  readonly starts: readonly StartSessionRequest[];
  readonly stops: readonly StopSessionRequest[];
  /** What every later start and stop answers with. */
  answerWith(outcome: SessionOutcome): void;
}

export interface FakeSessionControlOptions {
  readonly outcome?: SessionOutcome;
}

export function createFakeSessionControl(
  options: FakeSessionControlOptions = {},
): FakeSessionControl {
  const starts: StartSessionRequest[] = [];
  const stops: StopSessionRequest[] = [];

  let outcome: SessionOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake control was given no answer',
    holder: null,
  };

  return {
    async start(request: StartSessionRequest): Promise<SessionOutcome> {
      starts.push(request);
      return outcome;
    },

    async stop(request: StopSessionRequest): Promise<SessionOutcome> {
      stops.push(request);
      return outcome;
    },

    answerWith(next: SessionOutcome): void {
      outcome = next;
    },

    get starts(): readonly StartSessionRequest[] {
      return starts;
    },

    get stops(): readonly StopSessionRequest[] {
      return stops;
    },
  };
}
