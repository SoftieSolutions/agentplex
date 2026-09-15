import { describe, expect, it } from 'vitest';
import {
  loopbackServerAddress,
  pairedServerAddressSchema,
  serverAddressSchema,
  serverLabelSchema,
  serverTokenSchema,
} from './pairing.js';

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

  it('names the scheme it accidentally found, so the message points at the typo', () => {
    expect(problem('box.example:8443')).toContain('"box.example:"');
  });

  it('refuses credentials in the address: the pairing token is the credential', () => {
    expect(problem('wss://me:hunter2@box.example')).toContain('credential');
  });

  it('refuses a query string, where a smuggled secret would end up', () => {
    expect(problem('wss://box.example?token=hunter2')).toContain('query string');
  });

  it('refuses a fragment for the same reason', () => {
    expect(problem('wss://box.example#token')).toContain('fragment');
  });

  it('refuses the empty address', () => {
    expect(problem('   ')).not.toBe('');
  });

  it('refuses an address longer than a frame may carry', () => {
    expect(serverAddressSchema.safeParse(`wss://${'a'.repeat(4_000)}.example`).success).toBe(false);
  });
});

describe('pairedServerAddressSchema', () => {
  it('reads back the loopback address a one-box install wrote', () => {
    expect(pairedServerAddressSchema.parse('ws://127.0.0.1:8081')).toBe('ws://127.0.0.1:8081');
  });

  it('still refuses plaintext to anywhere else, which is the whole allowance', () => {
    expect(pairedServerAddressSchema.safeParse('ws://box.example:8443').success).toBe(false);
    expect(pairedServerAddressSchema.safeParse('ws://localhost:8081').success).toBe(false);
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

describe('serverLabelSchema', () => {
  it('trims and keeps what a person called their machine', () => {
    expect(serverLabelSchema.parse('  gpu-box-01 ')).toBe('gpu-box-01');
  });

  it('refuses a label that is only whitespace: a row has to be namable', () => {
    expect(serverLabelSchema.safeParse('   ').success).toBe(false);
  });

  it('refuses a label past the bound the column holds', () => {
    expect(serverLabelSchema.safeParse('n'.repeat(201)).success).toBe(false);
  });
});

describe('serverTokenSchema', () => {
  it('takes the token the server printed, trimmed of what a paste brought', () => {
    expect(serverTokenSchema.parse(' printed-by-the-server\n')).toBe('printed-by-the-server');
  });

  it('refuses the empty and the absurd, and rules on nothing else', () => {
    // How much entropy a token carries is the minting side's business. What
    // this parser is for is the two shapes that cannot be a token at all.
    expect(serverTokenSchema.safeParse('  ').success).toBe(false);
    expect(serverTokenSchema.safeParse('t'.repeat(4_097)).success).toBe(false);
    expect(serverTokenSchema.safeParse('t').success).toBe(true);
  });
});
