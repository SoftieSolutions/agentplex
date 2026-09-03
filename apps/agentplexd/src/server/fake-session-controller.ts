import type { SessionRef, StoreId } from '@agentplex/protocol';
import type {
  SessionController,
  SessionOutcome,
  StartSessionRequest,
  StoreReport,
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
  /** What the next start and stop answer with. */
  answerWith(outcome: SessionOutcome): void;
  /** What this server says is in a store. A store with no report is not mounted. */
  setReport(report: StoreReport): void;
}

export interface FakeSessionControllerOptions {
  readonly outcome?: SessionOutcome;
  readonly reports?: readonly StoreReport[];
}

export function createFakeSessionController(
  options: FakeSessionControllerOptions = {},
): FakeSessionController {
  const starts: StartSessionRequest[] = [];
  const stops: SessionRef[] = [];
  const reports = new Map<StoreId, StoreReport>(
    (options.reports ?? []).map((report) => [report.storeId, report]),
  );

  let outcome: SessionOutcome = options.outcome ?? {
    ok: false,
    code: 'refused',
    problem: 'this fake controller was given no answer',
    hold: null,
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

    async report(storeId: StoreId): Promise<StoreReport | null> {
      return reports.get(storeId) ?? null;
    },

    answerWith(next: SessionOutcome): void {
      outcome = next;
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
  };
}
