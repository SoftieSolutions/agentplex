import { describe, expect, it } from 'vitest';
import { parseClientFrame } from './client.js';
import { parseTextFrame } from './parse.js';

describe('parseTextFrame', () => {
  it('reads a well-formed frame', () => {
    const result = parseTextFrame(parseClientFrame, JSON.stringify({ type: 'ping', id: 1 }));
    expect(result).toEqual({ ok: true, value: { type: 'ping', id: 1 } });
  });

  it('reports bad JSON the same way it reports a bad shape: as a refusal, not a throw', () => {
    const result = parseTextFrame(parseClientFrame, '{not json');
    expect(result).toEqual({ ok: false, reason: 'frame is not valid JSON' });
  });

  it('names the offending field so a protocol error is debuggable from one log line', () => {
    const result = parseTextFrame(parseClientFrame, JSON.stringify({ type: 'ping', id: 'one' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('id');
  });
});
