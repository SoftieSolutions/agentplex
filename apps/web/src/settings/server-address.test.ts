import { describe, expect, it } from 'vitest';
import { parseServerAddress } from './server-address.js';

describe('the pairing form address parser', () => {
  it('accepts a wss address and returns it trimmed', () => {
    const parsed = parseServerAddress('  wss://gpu-box-01.example:8443  ');
    expect(parsed).toEqual({ ok: true, value: 'wss://gpu-box-01.example:8443' });
  });

  it('refuses something that is not a URL, and says what was expected', () => {
    const parsed = parseServerAddress('not an address');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('wss://box.example:8443');
  });

  it('refuses ws:// — a token must not cross a network in the clear', () => {
    const parsed = parseServerAddress('ws://gpu-box-01.example:8443');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('"ws:"');
  });

  it('refuses a bare host:port, naming the scheme it accidentally has', () => {
    const parsed = parseServerAddress('gpu-box-01.example:8443');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('"gpu-box-01.example:"');
  });

  it('refuses credentials embedded in the address', () => {
    const parsed = parseServerAddress('wss://user:secret@box.example:8443');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('the pairing token is the credential');
  });

  it('refuses a query string or fragment', () => {
    for (const address of ['wss://box.example:8443?x=1', 'wss://box.example:8443#frag']) {
      const parsed = parseServerAddress(address);
      expect(parsed.ok).toBe(false);
    }
  });
});
