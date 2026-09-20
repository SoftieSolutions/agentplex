import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { startDocumentTitle, type TitleSource } from './document-title.js';

/** The captured hub frames the list model and the floor are read from. */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** Two sessions asking, on two machines that are both reachable. */
const populated = stateFrom(hubFrames.machineStatePopulated);
/** The same fleet after a person spoke to it: one acknowledged, one muted. */
const attended = stateFrom(hubFrames.machineStateAttended);

interface FakeStore extends TitleSource {
  /** Land a new state on every listener, as a frame from the hub would. */
  push(next: MachineState | null): void;
  readonly listenerCount: number;
}

function fakeStore(initial: MachineState | null): FakeStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({ machineState: state }),
    push(next: MachineState | null): void {
      state = next;
      for (const listener of listeners) listener();
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}

describe('startDocumentTitle', () => {
  it('writes the count into the title when a state lands', () => {
    const store = fakeStore(null);
    const target = { title: 'agentplex' };

    startDocumentTitle(store, target);
    store.push(populated);

    expect(target.title).toBe('(2) agentplex');
  });

  it('takes the count back down when the fleet stops asking', () => {
    // The same two prompts, acknowledged and muted. A number that only ever
    // climbs is a number people stop believing.
    const store = fakeStore(populated);
    const target = { title: 'agentplex' };

    startDocumentTitle(store, target);
    expect(target.title).toBe('(2) agentplex');

    store.push(attended);
    expect(target.title).toBe('agentplex');
  });

  it('claims no number before the first state arrives', () => {
    const store = fakeStore(null);
    const target = { title: 'agentplex' };

    startDocumentTitle(store, target);

    expect(target.title).toBe('agentplex');
  });

  it('restores the title it found, and stops listening, on unsubscribe', () => {
    const store = fakeStore(populated);
    // Deliberately not the resting title: what teardown owes the page is the
    // title it took, not the one this module would have chosen.
    const target = { title: 'agentplex preview' };

    const stop = startDocumentTitle(store, target);
    expect(target.title).toBe('(2) agentplex');

    stop();

    expect(target.title).toBe('agentplex preview');
    expect(store.listenerCount).toBe(0);
    // Nothing the fleet does afterwards may reach a title this no longer owns.
    store.push(populated);
    expect(target.title).toBe('agentplex preview');
  });
});
