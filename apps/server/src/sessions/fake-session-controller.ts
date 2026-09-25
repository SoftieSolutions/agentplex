import type { SessionRef, StoreId } from '@agentplex/protocol';
import type {
  PauseOutcome,
  SessionController,
  SessionOutcome,
  StartSessionRequest,
  StoreReport,
  TranscriptOutcome,
  TranscriptSessionRequest,
} from './session-control.js';

/**
 * A session controller a test drives by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason every
 * other fake here is one: what the connection above it has to get right is what
 * it does with an outcome -- an answer, a refusal that names a hold, a store
 * that this server does not have -- and each of those is a value this produces.
 * Asserting that `start` was called would test the connection's shape instead
 * of its behaviour.
 *
 * It runs nothing. A test that wants a process forked wires the real controller
 * to a fake pty, which is what `session-start.integration.test` does.
 */
export interface FakeSessionController extends SessionController {
  /** Every start it was asked for, in order. */
  readonly starts: readonly StartSessionRequest[];
  /** Every stop it was asked for, in order. */
  readonly stops: readonly SessionRef[];
  /** Every pause and every resume it was asked for, in order. */
  readonly pauses: readonly SessionRef[];
  readonly resumes: readonly SessionRef[];
  /**
   * Every store scan it was asked for, in order.
   *
   * A scan is a disk read, so how many of them one instruction costs is a fact
   * worth asserting on: reporting a store to each connected hub separately
   * would be the same read repeated for an answer that cannot differ between
   * hubs.
   */
  readonly scans: readonly StoreId[];
  /** Every transcript it was asked for, in order. */
  readonly transcripts: readonly TranscriptSessionRequest[];
  /** What the next start and stop answer with. */
  answerWith(outcome: SessionOutcome): void;
  /** What the next pause and resume answer with. Its own shape, so its own setter. */
  answerPauseWith(outcome: PauseOutcome): void;
  /**
   * What the next transcript read answers with.
   *
   * Its own setter rather than sharing `answerWith`, because the two outcomes
   * are different shapes: a transcript refusal has no hold to name, since a
   * live process is never the reason a file cannot be read.
   */
  answerTranscriptWith(outcome: TranscriptOutcome): void;
  /** What this server says is in a store. A store with no report is not mounted. */
  setReport(report: StoreReport): void;
}

export interface FakeSessionControllerOptions {
  readonly outcome?: SessionOutcome;
  readonly transcript?: TranscriptOutcome;
  readonly reports?: readonly StoreReport[];
}

export function createFakeSessionController(
  options: FakeSessionControllerOptions = {},
): FakeSessionController {
  const starts: StartSessionRequest[] = [];
  const stops: SessionRef[] = [];
  const pauses: SessionRef[] = [];
  const resumes: SessionRef[] = [];
  const transcripts: TranscriptSessionRequest[] = [];
  const scans: StoreId[] = [];
  const reports = new Map<StoreId, StoreReport>(
    (options.reports ?? []).map((report) => [report.storeId, report]),
  );

  let outcome: SessionOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake controller was given no answer',
    hold: null,
  };

  let pause: PauseOutcome = {
    ok: false,
    code: 'refused',
    problem: 'this fake controller was given no pause answer',
    hold: null,
  };

  let transcript: TranscriptOutcome = options.transcript ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake controller was given no transcript',
  };

  return {
    async start(request: StartSessionRequest): Promise<SessionOutcome> {
      starts.push(request);
      return outcome;
    },

    stop(session: SessionRef): SessionOutcome {
      stops.push(session);
      return outcome;
    },

    pause(session: SessionRef): PauseOutcome {
      pauses.push(session);
      return pause;
    },

    resume(session: SessionRef): PauseOutcome {
      resumes.push(session);
      return pause;
    },

    async report(storeId: StoreId): Promise<StoreReport | null> {
      scans.push(storeId);
      return reports.get(storeId) ?? null;
    },

    async transcript(request: TranscriptSessionRequest): Promise<TranscriptOutcome> {
      transcripts.push(request);
      return transcript;
    },

    answerWith(next: SessionOutcome): void {
      outcome = next;
    },

    answerPauseWith(next: PauseOutcome): void {
      pause = next;
    },

    answerTranscriptWith(next: TranscriptOutcome): void {
      transcript = next;
    },

    setReport(report: StoreReport): void {
      reports.set(report.storeId, report);
    },

    get starts(): readonly StartSessionRequest[] {
      return starts;
    },

    get stops(): readonly SessionRef[] {
      return stops;
    },

    get pauses(): readonly SessionRef[] {
      return pauses;
    },

    get resumes(): readonly SessionRef[] {
      return resumes;
    },

    get scans(): readonly StoreId[] {
      return scans;
    },

    get transcripts(): readonly TranscriptSessionRequest[] {
      return transcripts;
    },
  };
}
