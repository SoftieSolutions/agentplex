import { describe, expect, it } from 'vitest';
import { assertNever } from './exhaustive.js';

describe('assertNever', () => {
  it('names what fell through, so the log line says which switch', () => {
    // A value the type system would never let here; the runtime still has to
    // say something useful about it.
    expect(() => assertNever({ type: 'unknown' } as never, 'server frame')).toThrow(
      'server frame: unhandled {"type":"unknown"}',
    );
  });
});
