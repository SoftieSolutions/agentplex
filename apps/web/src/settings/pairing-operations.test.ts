import { describe, expect, it } from 'vitest';
import { serverRegistrationIdSchema } from '@agentplex/protocol';
import { createBrowserPairingOperations } from './pairing-operations.js';

describe('the pairing operations this build ships', () => {
  it('refuses to pair, in words that say nothing was sent', async () => {
    const operations = createBrowserPairingOperations();
    const outcome = await operations.pairServer({
      label: 'gpu-box-01',
      address: 'wss://gpu-box-01.example:8443',
      token: 'printed-by-the-server',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('no client-reachable pairing operation');
      expect(outcome.reason).toContain('nothing was sent');
    }
  });

  it('refuses to unpair the same way', async () => {
    const operations = createBrowserPairingOperations();
    const outcome = await operations.unpairServer(serverRegistrationIdSchema.parse('pairing-1'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('nothing was sent');
  });
});
