import { describe, expect, it } from 'vitest';
import { clientInstanceSchema } from '@agentplex/protocol';
import { mintClientInstance } from './client-instance.js';

describe('mintClientInstance', () => {
  it('writes the sixteen bytes it is given as lowercase hex', () => {
    const instance = mintClientInstance((bytes) => {
      bytes.forEach((_, index) => {
        bytes[index] = index * 17;
      });
    });

    expect(instance).toBe('00112233445566778899aabbccddeeff');
  });

  it('mints a different page each time from the real source', () => {
    const one = mintClientInstance();
    const two = mintClientInstance();

    expect(clientInstanceSchema.safeParse(one).success).toBe(true);
    expect(clientInstanceSchema.safeParse(two).success).toBe(true);
    expect(one).not.toBe(two);
  });
});
