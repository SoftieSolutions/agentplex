import { sessionRefSchema, storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeProviderAdapter } from './fake-provider-adapter.js';

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/fake' });
const SESSION_ID = 'session-1';

describe('createFakeProviderAdapter.liveProcess', () => {
  it('names the process a test wrote down for a session, and none for any other', async () => {
    const adapter = createFakeProviderAdapter({
      liveProcesses: { [SESSION_ID]: { pid: 4_321, phase: 'idle' } },
    });

    expect(
      await adapter.liveProcess(
        STORE,
        sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID }),
      ),
    ).toEqual({ pid: 4_321, phase: 'idle' });
    expect(
      await adapter.liveProcess(
        STORE,
        sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: 'session-2' }),
      ),
    ).toBeNull();
  });

  it('names no process at all by default, which is a provider with no registry', async () => {
    expect(
      await createFakeProviderAdapter().liveProcess(
        STORE,
        sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID }),
      ),
    ).toBeNull();
  });
});
