import { describe, expect, it } from 'vitest';
import { serverRegistrationIdSchema } from '@agentplex/protocol';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { appSessionFiltersStore, createSessionFiltersStore } from './session-filters-store.js';
import { NO_FILTERS } from './session-list-model.js';

const MACHINE = serverRegistrationIdSchema.parse('reg-1');

/**
 * A hub store nobody subscribes to: constructing one asks for nothing, which
 * is what makes it usable here as the identity the narrowings hang off.
 */
function hubStore(): HubStore {
  const sockets = createFakeSocketFactory();
  return createHubStore({
    fetchTicket: () => Promise.resolve('ticket-1'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: createFrameIdCounter(),
  });
}

describe('the narrowings store', () => {
  it('starts with nothing narrowed', () => {
    expect(createSessionFiltersStore().getSnapshot()).toEqual(NO_FILTERS);
  });

  it('writes the narrowing it is given and leaves the others standing', () => {
    const filters = createSessionFiltersStore();

    filters.set({ machine: 'reg-1' });
    filters.set({ chip: 'needs-you' });

    expect(filters.getSnapshot()).toEqual({
      ...NO_FILTERS,
      machine: 'reg-1',
      chip: 'needs-you',
    });
  });

  it('publishes to everyone subscribed, and to nobody who has left', () => {
    const filters = createSessionFiltersStore();
    let popover = 0;
    let screen = 0;
    const leave = filters.subscribe(() => {
      popover += 1;
    });
    filters.subscribe(() => {
      screen += 1;
    });

    filters.set({ project: 'agentplex' });
    leave();
    filters.set({ search: 'deploy' });

    expect(popover).toBe(1);
    expect(screen).toBe(2);
  });

  it('keeps one snapshot when a write changes nothing', () => {
    const filters = createSessionFiltersStore();
    filters.set({ updatedWithin: '1h' });
    const before = filters.getSnapshot();
    let published = 0;
    filters.subscribe(() => {
      published += 1;
    });

    filters.set({ updatedWithin: '1h' });

    // Identity and not just equality: `useSyncExternalStore` compares the
    // snapshot it is handed, so a write that narrowed nothing must not hand it
    // a second object and re-render both readers over it.
    expect(filters.getSnapshot()).toBe(before);
    expect(published).toBe(0);
  });

  it('clears every narrowing and the search, and keeps the machine selection', () => {
    const filters = createSessionFiltersStore();
    filters.set({
      search: 'deploy',
      chip: 'running',
      storeId: 'store-work',
      provider: 'claude',
      machine: 'reg-2',
      project: 'agentplex',
      updatedWithin: '24h',
      server: MACHINE,
    });
    let published = 0;
    filters.subscribe(() => {
      published += 1;
    });

    filters.clear();

    // The selector's choice survives: it is the shell's, written through
    // `onPickMachine`, and nobody pressing Clear in a session filter means to
    // move the app to another machine.
    expect(filters.getSnapshot()).toEqual({ ...NO_FILTERS, server: MACHINE });
    expect(published).toBe(1);
  });

  it('clears nothing twice', () => {
    const filters = createSessionFiltersStore();
    filters.set({ chip: 'idle' });
    filters.clear();
    const cleared = filters.getSnapshot();

    filters.clear();

    expect(filters.getSnapshot()).toBe(cleared);
  });

  it('is one store per page, so the popover and the list read one source', () => {
    const hub = hubStore();

    const popover = appSessionFiltersStore(hub);
    const screen = appSessionFiltersStore(hub);
    popover.set({ project: 'agentplex' });

    expect(screen).toBe(popover);
    expect(screen.getSnapshot().project).toBe('agentplex');
    expect(appSessionFiltersStore(hubStore())).not.toBe(popover);
  });
});
