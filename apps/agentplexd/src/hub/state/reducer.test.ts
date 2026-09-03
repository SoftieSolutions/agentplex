import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger } from '../../shared/logger.js';
import { serverAddressSchema } from '../pairing/server-address.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
} from '../connections/server-connection.js';
import { createReducer, type Reducer, type StoreView } from './reducer.js';

/**
 * The merge, driven by hand.
 *
 * Everything here is two servers and one volume, because that is the case the
 * reducer exists for: one store, one session list, N servers attached, and a
 * row that is always some server's row rather than an assembly of several.
 */

const START = 1_756_000_000_000;

const logger = createLogger('error', () => {});

function store(id: string): StoreId {
  return storeIdSchema.parse(id);
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly string[],
  overrides: Partial<ServerConnectionReport> = {},
): ServerConnectionReport {
  return {
    registrationId: `registration-${label}` as ServerRegistrationId,
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    // Every phase but the first dial has had a connection at some point; that
    // is what a stale label's age is measured from.
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    storeId: store('store-work'),
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status: 'idle',
    updatedAt: START,
    cwd: '/srv/work',
    title: null,
    ...overrides,
  };
}

function reduce(): Reducer {
  return createReducer({ logger });
}

/** The one store the fixtures use, or a failure that names what was there instead. */
function only(views: readonly StoreView[]): StoreView {
  expect(views.map((view) => view.storeId)).toHaveLength(1);
  const [view] = views;
  if (view === undefined) throw new Error('no store view');
  return view;
}

function sessionIds(view: StoreView): readonly string[] {
  return view.sessions.map((row) => row.descriptor.sessionId);
}

describe('storeId stamping', () => {
  it('files a session under the store the reporting server was speaking for', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    const view = only(reducer.snapshot().stores);
    expect(view.storeId).toBe('store-work');
    expect(view.sessions[0]?.ref).toEqual({
      storeId: store('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    });
  });

  it('drops a session that claims a different store than the report it arrived in', () => {
    // The row costs itself and the rest of the list survives. Filing it under
    // the store it named would let one server's bookkeeping error appear as a
    // session in a store it has nothing to do with.
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-2', { storeId: store('store-other') })],
      reportedAt: START,
    });

    const snapshot = reducer.snapshot();
    expect(sessionIds(only(snapshot.stores))).toEqual(['session-1']);
    expect(snapshot.stores.map((view) => view.storeId)).not.toContain('store-other');
  });

  it('refuses a report for a store the server has not said it has mounted', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));

    const accepted = reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-elsewhere'),
      sessions: [session('session-1', { storeId: store('store-elsewhere') })],
      reportedAt: START,
    });

    expect(accepted).toBe(false);
    // The store it has mounted is still a store; the one it does not is not.
    const views = reducer.snapshot().stores;
    expect(views.map((view) => view.storeId)).toEqual(['store-work']);
    expect(sessionIds(only(views))).toEqual([]);
  });

  it('refuses a report from a server it holds no connection for', () => {
    const reducer = reduce();

    const accepted = reducer.applySessions({
      holding: [],
      registrationId: 'registration-ghost' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    expect(accepted).toBe(false);
    expect(reducer.snapshot().stores).toHaveLength(0);
  });
});

describe('two servers on one volume', () => {
  function twoServers(): Reducer {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applyConnection(connection('ec2', 'connected', ['store-work']));
    return reducer;
  }

  it('is one store with both servers attached, not two stores', () => {
    const reducer = twoServers();

    const view = only(reducer.snapshot().stores);
    expect(view.servers.map((attached) => attached.label).sort()).toEqual(['ec2', 'laptop']);
    expect(view.reachable).toBe(true);
  });

  it("unifies the session list rather than listing each server's copy", () => {
    const reducer = twoServers();
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-2')],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-ec2' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-3')],
      reportedAt: START,
    });

    const view = only(reducer.snapshot().stores);
    expect(sessionIds(view)).toEqual(['session-1', 'session-2', 'session-3']);
  });

  it('records every server that reported a session, and which one the row came from', () => {
    const reducer = twoServers();
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1', { status: 'working' })],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-ec2' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1', { status: 'idle' })],
      reportedAt: START,
    });

    const [row] = only(reducer.snapshot().stores).sessions;
    expect(row?.reportedBy).toEqual(['registration-ec2', 'registration-laptop']);
    // The one server that could see a process is the one whose row is shown.
    expect(row?.source).toBe('registration-laptop');
    expect(row?.descriptor.status).toBe('working');
  });

  it('keeps a session that one server has stopped reporting while the other still does', () => {
    const reducer = twoServers();
    for (const registration of ['registration-laptop', 'registration-ec2']) {
      reducer.applySessions({
        holding: [],
        registrationId: registration as ServerRegistrationId,
        storeId: store('store-work'),
        sessions: [session('session-1')],
        reportedAt: START,
      });
    }

    // The laptop unmounted nothing and lost nothing; its scan simply no longer
    // finds the session. The store still has it, because a server still sees it.
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [],
      reportedAt: START + 1_000,
    });

    const view = only(reducer.snapshot().stores);
    expect(sessionIds(view)).toEqual(['session-1']);
    expect(view.sessions[0]?.reportedBy).toEqual(['registration-ec2']);
  });
});

describe('whole-row replacement', () => {
  function withOneServer(): Reducer {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    return reducer;
  }

  it('lets a later report clear a field the earlier one filled', () => {
    // The merge-by-field failure mode, exactly: a title that was renamed away
    // must not survive because the new row happens to say null there.
    const reducer = withOneServer();
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1', { title: 'refactor the parser', cwd: '/srv/work' })],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1', { title: null, cwd: null, updatedAt: START + 1_000 })],
      reportedAt: START + 1_000,
    });

    const [row] = only(reducer.snapshot().stores).sessions;
    expect(row?.descriptor.title).toBeNull();
    expect(row?.descriptor.cwd).toBeNull();
    expect(row?.descriptor.updatedAt).toBe(START + 1_000);
  });

  it('shows the descriptor the server sent, not a copy assembled from it', () => {
    const reducer = withOneServer();
    const sent = session('session-1', { title: 'one' });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [sent],
      reportedAt: START,
    });

    expect(only(reducer.snapshot().stores).sessions[0]?.descriptor).toBe(sent);
  });

  it('drops a session that a report no longer carries', () => {
    const reducer = withOneServer();
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-2')],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-2')],
      reportedAt: START + 1_000,
    });

    expect(sessionIds(only(reducer.snapshot().stores))).toEqual(['session-2']);
  });

  it("replaces one store's list without touching another's", () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work', 'store-notes']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-notes'),
      sessions: [session('session-9', { storeId: store('store-notes') })],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [],
      reportedAt: START + 1_000,
    });

    const views = reducer.snapshot().stores;
    expect(views.map((view) => view.storeId)).toEqual(['store-notes', 'store-work']);
    expect(sessionIds(views[0] as StoreView)).toEqual(['session-9']);
    expect(sessionIds(views[1] as StoreView)).toEqual([]);
  });
});

describe('staleness', () => {
  it("keeps an unreachable server's sessions and labels them", () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    reducer.applyConnection(connection('laptop', 'stale', ['store-work']));

    const view = only(reducer.snapshot().stores);
    expect(sessionIds(view)).toEqual(['session-1']);
    expect(view.reachable).toBe(false);
    expect(view.unreachableSince).toBe(START + 1_000);
    expect(view.lastReachableAt).toBe(START);
    expect(view.sessions[0]?.reachable).toBe(false);
  });

  it('leaves a store reachable while any one of its servers is connected', () => {
    // A session is {storeId, sessionId} and never the machine: if anybody can
    // reach the volume, the sessions on it can be answered.
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'stale', ['store-work']));
    reducer.applyConnection(connection('ec2', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-ec2' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    const view = only(reducer.snapshot().stores);
    expect(view.reachable).toBe(true);
    expect(view.unreachableSince).toBeNull();
    expect(view.sessions[0]?.reachable).toBe(true);
  });

  it('does not call a store reachable on a dial that is still in flight', () => {
    const reducer = reduce();
    reducer.applyConnection(
      connection('laptop', 'connecting', ['store-work'], { lastConnectedAt: START - 5_000 }),
    );

    const view = only(reducer.snapshot().stores);
    expect(view.reachable).toBe(false);
    expect(view.lastReachableAt).toBe(START - 5_000);
    expect(view.unreachableSince).toBeNull();
  });
});

describe('detach and reattach', () => {
  it('forgets a server whose pairing has gone, and its rows with it', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    reducer.applyConnection(connection('laptop', 'stopped', ['store-work']));

    // Revoked is not unreachable. The operator said this machine may not be
    // dialled, so it is not a server the hub is waiting on -- it is gone, and
    // so is the only claim its rows rested on.
    expect(reducer.snapshot().stores).toHaveLength(0);
    expect(reducer.snapshot().servers).toHaveLength(0);
  });

  it('keeps the store when one of two attached servers goes away', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applyConnection(connection('ec2', 'connected', ['store-work']));
    for (const registration of ['registration-laptop', 'registration-ec2']) {
      reducer.applySessions({
        holding: [],
        registrationId: registration as ServerRegistrationId,
        storeId: store('store-work'),
        sessions: [session('session-1')],
        reportedAt: START,
      });
    }

    reducer.applyConnection(connection('laptop', 'stopped', ['store-work']));

    const view = only(reducer.snapshot().stores);
    expect(view.servers.map((attached) => attached.label)).toEqual(['ec2']);
    expect(sessionIds(view)).toEqual(['session-1']);
    expect(view.sessions[0]?.source).toBe('registration-ec2');
  });

  it("takes a reattached server's new list rather than resurrecting its old one", () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-2')],
      reportedAt: START,
    });
    reducer.applyConnection(connection('laptop', 'stale', ['store-work']));

    // Back, and the store now holds one session: the other was deleted while
    // the hub could not see the machine.
    reducer.applyConnection(
      connection('laptop', 'connected', ['store-work'], { connectedSince: START + 9_000 }),
    );
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-2')],
      reportedAt: START + 9_000,
    });

    const view = only(reducer.snapshot().stores);
    expect(view.reachable).toBe(true);
    expect(sessionIds(view)).toEqual(['session-2']);
  });

  it('drops the rows for a store a reconnected server no longer has mounted', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work', 'store-notes']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-notes'),
      sessions: [session('session-9', { storeId: store('store-notes') })],
      reportedAt: START,
    });

    // The volume was unmounted before the machine came back. Its sessions are
    // not stale, they are not this server's to report at all any more.
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));

    expect(reducer.snapshot().stores.map((view) => view.storeId)).toEqual(['store-work']);
  });
});

describe('the change signal', () => {
  it('tells a subscriber once per change, with the state that resulted', () => {
    const reducer = reduce();
    const seen: number[] = [];
    reducer.subscribe((snapshot) => seen.push(snapshot.version));

    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    expect(seen).toEqual([1, 2]);
    expect(reducer.snapshot().version).toBe(2);
  });

  it('says nothing when a report changes nothing', () => {
    // Servers report on a schedule. A store nobody touched between two scans
    // must not wake every client up.
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    const seen: number[] = [];
    reducer.subscribe((snapshot) => seen.push(snapshot.version));
    reducer.applySessions({
      holding: [],
      registrationId: 'registration-laptop' as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START + 30_000,
    });

    expect(seen).toEqual([]);
  });

  it('stops telling a subscriber that has unsubscribed', () => {
    const reducer = reduce();
    const seen: number[] = [];
    const unsubscribe = reducer.subscribe((snapshot) => seen.push(snapshot.version));

    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));
    unsubscribe();
    reducer.applyConnection(connection('ec2', 'connected', ['store-work']));

    expect(seen).toEqual([1]);
  });

  it('costs the state nothing when a subscriber throws', () => {
    const reducer = reduce();
    reducer.subscribe(() => {
      throw new Error('a client socket died mid-broadcast');
    });
    const seen: number[] = [];
    reducer.subscribe((snapshot) => seen.push(snapshot.version));

    expect(() =>
      reducer.applyConnection(connection('laptop', 'connected', ['store-work'])),
    ).not.toThrow();
    expect(seen).toEqual([1]);
    expect(reducer.snapshot().stores).toHaveLength(1);
  });

  it('hands out the same snapshot until something changes', () => {
    const reducer = reduce();
    reducer.applyConnection(connection('laptop', 'connected', ['store-work']));

    const first = reducer.snapshot();
    expect(reducer.snapshot()).toBe(first);

    reducer.applyConnection(connection('ec2', 'connected', ['store-work']));
    expect(reducer.snapshot()).not.toBe(first);
  });
});
