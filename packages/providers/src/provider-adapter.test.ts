import { describe, expect, it } from 'vitest';
import { statusFromObservation, type TranscriptSignal } from './provider-adapter.js';

describe('statusFromObservation', () => {
  const observed = { updatedAt: 1_756_000_000_000, now: 1_756_000_001_000 };

  it('passes a state that wants a human straight through, running or not', () => {
    for (const signal of ['awaiting-permission', 'awaiting-input'] as const) {
      expect(statusFromObservation({ ...observed, signal, running: true })).toBe(signal);
      expect(statusFromObservation({ ...observed, signal, running: false })).toBe(signal);
    }
  });

  it('reports a verified live process as working', () => {
    expect(statusFromObservation({ ...observed, signal: 'progressing', running: true })).toBe(
      'working',
    );
    expect(statusFromObservation({ ...observed, signal: 'quiet', running: true })).toBe('working');
  });

  it('calls a session with nothing verifiably running idle rather than working', () => {
    expect(statusFromObservation({ ...observed, signal: 'progressing', running: false })).toBe(
      'idle',
    );
    expect(statusFromObservation({ ...observed, signal: 'quiet', running: false })).toBe('idle');
  });

  it('keeps an unrecognised transcript unknown unless a process is verifiably running', () => {
    expect(statusFromObservation({ ...observed, signal: 'unknown', running: false })).toBe(
      'unknown',
    );
    // A live process is evidence the transcript could not give: something is
    // working, whatever the file failed to say.
    expect(statusFromObservation({ ...observed, signal: 'unknown', running: true })).toBe(
      'working',
    );
  });

  it('gives the same answer however long ago the last write was', () => {
    // A just-written transcript and one untouched for a day must map alike:
    // elapsed time is supplied, never turned into a status.
    const signals: readonly TranscriptSignal[] = [
      'awaiting-permission',
      'awaiting-input',
      'progressing',
      'quiet',
      'unknown',
    ];
    const updatedAt = 1_756_000_000_000;
    const moments = [
      { updatedAt, now: updatedAt },
      { updatedAt, now: updatedAt + 24 * 60 * 60 * 1000 },
      { updatedAt: updatedAt - 60 * 60 * 1000, now: updatedAt },
    ];

    for (const signal of signals) {
      for (const running of [true, false]) {
        const answers = moments.map((moment) =>
          statusFromObservation({ ...moment, signal, running }),
        );
        expect(new Set(answers).size).toBe(1);
      }
    }
  });
});
