import type {
  Sessions,
  SessionOutcome,
  StartOutcome,
  StartSessionRequest,
  StopSessionRequest,
  TranscriptOutcome,
  TranscriptRequest,
} from './sessions.js';

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
export interface FakeSessions extends Sessions {
  readonly starts: readonly StartSessionRequest[];
  readonly stops: readonly StopSessionRequest[];
  /**
   * What every later start and stop answers with.
   *
   * A start's outcome, because it is the wider of the two: a stop answered
   * with one is answered with a field it does not declare, which no reader of
   * a stop can see, and the alternative is two answers to set on a fake whose
   * every test sets one.
   */
  answerWith(outcome: StartOutcome): void;
  /** Every transcript it was asked for, in order. */
  readonly transcripts: readonly TranscriptRequest[];
  /**
   * What every later transcript read answers with.
   *
   * Its own setter rather than sharing `answerWith`, because the outcomes are
   * different shapes: a transcript refusal names no holder, since a live
   * process is never the reason a file cannot be read.
   */
  answerTranscriptWith(outcome: TranscriptOutcome): void;
}

export interface FakeSessionsOptions {
  readonly outcome?: StartOutcome;
  readonly transcript?: TranscriptOutcome;
}

export function createFakeSessions(options: FakeSessionsOptions = {}): FakeSessions {
  const starts: StartSessionRequest[] = [];
  const stops: StopSessionRequest[] = [];
  const transcripts: TranscriptRequest[] = [];

  let outcome: StartOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake control was given no answer',
    holder: null,
  };

  let transcript: TranscriptOutcome = options.transcript ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake control was given no transcript',
  };

  return {
    async start(request: StartSessionRequest): Promise<StartOutcome> {
      starts.push(request);
      return outcome;
    },

    async stop(request: StopSessionRequest): Promise<SessionOutcome> {
      stops.push(request);
      return outcome;
    },

    async transcript(request: TranscriptRequest): Promise<TranscriptOutcome> {
      transcripts.push(request);
      return transcript;
    },

    answerWith(next: StartOutcome): void {
      outcome = next;
    },

    answerTranscriptWith(next: TranscriptOutcome): void {
      transcript = next;
    },

    get starts(): readonly StartSessionRequest[] {
      return starts;
    },

    get stops(): readonly StopSessionRequest[] {
      return stops;
    },

    get transcripts(): readonly TranscriptRequest[] {
      return transcripts;
    },
  };
}
