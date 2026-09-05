import { describe, expect, it } from 'vitest';
import { loopbackServerAddress, serverAddressSchema } from './server-address.js';

function problem(text: string): string {
  const parsed = serverAddressSchema.safeParse(text);
  expect(parsed.success).toBe(false);
  return parsed.error?.issues.map((issue) => issue.message).join('; ') ?? '';
}

describe('serverAddressSchema', () => {
  it('accepts a wss address with a host and a port', () => {
    expect(serverAddressSchema.parse('wss://box.example:8443')).toBe('wss://box.example:8443');
  });

  it('accepts a path, because a server can sit behind a reverse proxy', () => {
    expect(serverAddressSchema.parse('wss://gate.example/agentplex')).toBe(
      'wss://gate.example/agentplex',
    );
  });

  it('trims what a paste brought with it rather than storing an unusable address', () => {
    expect(serverAddressSchema.parse('  wss://box.example:8443\n')).toBe('wss://box.example:8443');
  });

  it('refuses ws, so a token is never sent over a network in the clear', () => {
    expect(problem('ws://box.example:8443')).toContain('wss://');
  });

  it('refuses https, which is the other thing people paste', () => {
    expect(problem('https://box.example')).toContain('wss://');
  });

  it('refuses a bare host, rather than guessing a scheme for it', () => {
    // `box.example:8443` is a valid URL whose scheme is `box.example:`, which
    // is exactly why this needs saying: it does not fail on its own.
    expect(problem('box.example:8443')).toContain('wss://');
  });

  it('refuses credentials in the address: the pairing token is the credential', () => {
    expect(problem('wss://me:hunter2@box.example')).toContain('credential');
  });

  it('refuses a query string, where a smuggled secret would end up', () => {
    expect(problem('wss://box.example?token=hunter2')).toContain('query string');
  });

  it('refuses the empty address', () => {
    expect(problem('   ')).not.toBe('');
  });
});

describe('loopbackServerAddress', () => {
  it('builds the address of a server in this same process', () => {
    expect(loopbackServerAddress(8081)).toBe('ws://127.0.0.1:8081');
  });

  it('takes a port and nothing else, so no host can be asked for', () => {
    // The bound, expressed as a signature: there is no parameter here through
    // which somebody else's machine could arrive. Every other address in this
    // build comes from `serverAddressSchema`, which refuses `ws://` outright.
    expect(problem('ws://127.0.0.1:8081')).toContain('wss://');
  });

  it('refuses a port that is not one, rather than formatting it into an address', () => {
    expect(loopbackServerAddress(0)).toBeNull();
    expect(loopbackServerAddress(65_536)).toBeNull();
    expect(loopbackServerAddress(8081.5)).toBeNull();
  });

  it('is a ServerAddress nobody can produce by typing one', () => {
    // Both halves matter. It is a real `ServerAddress`, so the pairing table
    // takes it without anything casting; and the address it produces is still
    // refused by the parser a pairing form goes through, so the plaintext
    // allowance cannot be reached from outside this build.
    const address = loopbackServerAddress(8081);
    expect(address).not.toBeNull();
    expect(serverAddressSchema.safeParse(String(address)).success).toBe(false);
  });
});
