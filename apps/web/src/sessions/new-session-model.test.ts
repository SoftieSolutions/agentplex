import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  serverRegistrationIdSchema,
  storeIdSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StartedView } from '../store/hub-store.js';
import {
  buildStart,
  deliveryWords,
  parsePrompt,
  providerOffer,
  resolveProvider,
  serverOverrideChoices,
  sessionPaneHash,
  startFollowUp,
  startableStores,
  submitBlockedReason,
} from './new-session-model.js';

/**
 * The flow's rules against captured hub output. Every machine state here was
 * assembled by a real hub from real store reports (hub-frames.fixture.ts), and
 * the start reply is the one a real hub sent back to a real session-start.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** A captured refusal, as the store would put it in a snapshot. */
function refusalFrom(text: string): RefusalView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'refusal') {
    throw new Error('the fixture is not a refusal frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    code: frame.code,
    message: frame.message,
    holder: frame.holder,
  };
}

/** The captured session-started reply, as the store would put it in a snapshot. */
function startedFrom(text: string): StartedView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-started') {
    throw new Error('the fixture is not a session-started frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    storeId: frame.storeId,
    sessionId: frame.sessionId,
    server: frame.server,
  };
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const single = stateFrom(hubFrames.machineStateSingle);
const empty = stateFrom(hubFrames.machineState);
const shared = stateFrom(hubFrames.machineStateShared);
const sharedDegraded = stateFrom(hubFrames.machineStateSharedDegraded);

const mixed = stateFrom(hubFrames.machineStateProviders);
const stale = stateFrom(hubFrames.machineStateStale);

const AGENTPLEX = storeIdSchema.parse('store-agentplex');
const SHARED = storeIdSchema.parse('store-shared');
const MIXED = storeIdSchema.parse('store-mixed');
const UNIVERSE = storeIdSchema.parse('store-universe');

const GPU = serverRegistrationIdSchema.parse('registration-gpu-box-01');
const MBP = serverRegistrationIdSchema.parse('registration-mbp-robert');
const MINI = serverRegistrationIdSchema.parse('registration-mini-01');
const OLD = serverRegistrationIdSchema.parse('registration-old-box-01');

/** The offer a form with nothing chosen anywhere is looking at. */
const NOTHING = providerOffer(null, null, null);

describe('store picker', () => {
  it('offers every store the hub reports, in hub order', () => {
    expect(startableStores(populated)).toEqual(['store-agentplex', 'store-universe']);
  });

  it('offers the one store there is: the form names it in words instead of a picker', () => {
    expect(startableStores(single)).toEqual(['store-agentplex']);
  });

  it('offers nothing when no server reports a store', () => {
    expect(startableStores(empty)).toEqual([]);
  });
});

describe('server override', () => {
  it('is not drawn when one machine has the store: there is no decision to override', () => {
    expect(serverOverrideChoices(populated, AGENTPLEX)).toEqual([]);
  });

  it('is drawn when two connected machines share the volume, worded by label', () => {
    expect(serverOverrideChoices(shared, SHARED)).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
  });

  it('is not drawn when the shared volume degrades to one reachable machine', () => {
    expect(serverOverrideChoices(sharedDegraded, SHARED)).toEqual([]);
  });

  it('is not drawn before a store is chosen', () => {
    expect(serverOverrideChoices(shared, null)).toEqual([]);
  });

  /**
   * The narrowing the chosen provider brings, which is the hub's rule
   * reflected rather than a second one: the hub refuses a machine that cannot
   * run the provider, in that machine's own words, so a menu listing it would
   * be a menu of one live option and one apology.
   *
   * It applies to every start and not only to a start in a project, which is
   * the rule this replaces: the provider is now the user's own choice rather
   * than a literal on the frame, and a machine that cannot honour it is
   * offering a refusal whether or not a project was named. A project narrows
   * nothing here, because nothing on the wire ties one to a machine -- a
   * project is a node with a directory, and whether that directory sits under
   * a root is answered by the machine that has the disk.
   */
  it('drops a machine that cannot start the chosen provider', () => {
    // Both machines have the shared volume; only one of them has codex.
    expect(serverOverrideChoices(shared, SHARED, 'codex')).toEqual([
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
    expect(serverOverrideChoices(shared, SHARED, 'claude')).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
  });

  /**
   * The control is drawn from two *candidates* rather than two survivors of the
   * narrowing. A fleet where only one machine can run the chosen provider is a
   * fact worth showing, and hiding the control instead would silently unchoose
   * the machine the user had already picked.
   */
  it('stays drawn when the provider narrows a fleet of four down to one', () => {
    expect(serverOverrideChoices(mixed, MIXED, 'codex')).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
    ]);
  });

  it('counts a provider the machine could not question as startable, as the hub does', () => {
    // gpu-box-01's claude is `unknown`: the binary resolved and the version
    // probe did not answer. `readinessRefusal` says that is not a refusal, so
    // a client that dropped the machine would be stricter than the hub it is
    // trying to agree with.
    expect(serverOverrideChoices(mixed, MIXED, 'claude')).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
  });
});

/**
 * What the provider control offers, which is the whole of this flow's answer to
 * "the client can only start a claude session". Every case below is read off a
 * single captured frame in which four machines on one volume disagree about
 * what they can start.
 */
describe('the provider offer', () => {
  it("is the union of what the store's live machines can start, when the hub places", () => {
    expect(providerOffer(mixed, MIXED, null)).toEqual({
      options: [
        // Startable on gpu-box-01 despite the unread version, and ready on
        // mbp-robert. The caveat names the machine it came from.
        {
          provider: 'claude',
          caveat: 'gpu-box-01: claude could not report its version: it exited 1',
        },
        { provider: 'codex', caveat: null },
      ],
      // Nothing to explain: every provider named anywhere on this store can be
      // started somewhere on it, and which machine is the machine list's job.
      problems: [],
    });
  });

  it("is that one machine's answer once a machine is chosen", () => {
    expect(providerOffer(mixed, MIXED, MBP)).toEqual({
      options: [{ provider: 'claude', caveat: null }],
      problems: [
        'mbp-robert cannot run codex: codex is installed and logged out; run its login on that machine',
      ],
    });
  });

  it('shows an unread provider with its problem beside it rather than dropping it', () => {
    expect(providerOffer(mixed, MIXED, GPU)).toEqual({
      options: [
        {
          provider: 'claude',
          caveat: 'gpu-box-01: claude could not report its version: it exited 1',
        },
        { provider: 'codex', caveat: null },
      ],
      problems: [],
    });
  });

  it('says a build with no adapters is one, which is not a machine to go and fix', () => {
    expect(providerOffer(mixed, MIXED, MINI)).toEqual({
      options: [],
      problems: ['mini-01 reports no providers: that build carries no provider adapters'],
    });
  });

  it("gives each unstartable provider its own next action, in the machine's words", () => {
    // An install and a login are different things to go and do, and the two
    // sentences are the machine's own: the client is repeating a fact rather
    // than diagnosing one.
    expect(providerOffer(mixed, MIXED, OLD)).toEqual({
      options: [],
      problems: [
        'old-box-01 cannot run claude: no directory this server searches holds claude',
        'old-box-01 cannot run codex: codex is installed and logged out; run its login on that machine',
      ],
    });
  });

  it('offers nothing a machine the hub cannot reach says it has', () => {
    // The stale row keeps its providers -- that is the point of keeping it --
    // but a start routed there would be refused, so none of it is offered.
    expect(providerOffer(stale, UNIVERSE, null)).toEqual({ options: [], problems: [] });
  });

  it('offers nothing before a store is chosen, and nothing without a state', () => {
    expect(providerOffer(mixed, null, null)).toEqual({ options: [], problems: [] });
    expect(NOTHING).toEqual({ options: [], problems: [] });
  });
});

describe('the chosen provider', () => {
  it('is the only one there is, chosen or not: one option is not a question', () => {
    const offer = providerOffer(mixed, MIXED, MBP);
    expect(resolveProvider(offer, null)).toBe('claude');
    expect(resolveProvider(offer, 'codex')).toBe('claude');
  });

  it('is nothing until one of several is picked', () => {
    const offer = providerOffer(mixed, MIXED, null);
    expect(resolveProvider(offer, null)).toBeNull();
    expect(resolveProvider(offer, 'codex')).toBe('codex');
  });

  it('forgets a choice the current frame no longer offers', () => {
    // The machine the user then picked cannot run it. The choice survives in
    // the component's state in case its option returns; it does not reach the
    // frame while it is not on offer.
    expect(resolveProvider(providerOffer(mixed, MIXED, MBP), 'codex')).toBe('claude');
    expect(resolveProvider(NOTHING, 'claude')).toBeNull();
  });
});

describe('the frame', () => {
  it('builds a session-start the protocol parser accepts, exactly as typed', () => {
    const command = buildStart(AGENTPLEX, 'claude', null, '  fix the auth refresh loop  ');
    const parsed = parseClientFrame({ ...command, id: 7 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toEqual({
      type: 'session-start',
      id: 7,
      storeId: 'store-agentplex',
      sessionId: null,
      provider: 'claude',
      prompt: 'fix the auth refresh loop',
      server: null,
      project: null,
    });
  });

  it('carries the project as a node id when one was picked, and never a path', () => {
    const command = buildStart(AGENTPLEX, 'claude', null, '', nodeIdSchema.parse('node-9'));
    expect(command.type === 'session-start' && command.project).toBe('node-9');
    expect(Object.keys(command)).not.toContain('directory');
  });

  it('carries the provider the user chose, which is no longer a literal', () => {
    const offer = providerOffer(mixed, MIXED, null);
    const provider = resolveProvider(offer, 'codex');
    if (provider === null) throw new Error('the mixed fixture offers no codex');
    const command = buildStart(MIXED, provider, null, '');
    expect(command.type === 'session-start' && command.provider).toBe('codex');
  });

  it('carries the override when one was picked', () => {
    const [gpu] = serverOverrideChoices(shared, SHARED);
    if (gpu === undefined) throw new Error('the shared fixture offers no override');
    const command = buildStart(SHARED, 'claude', gpu.id, '');
    expect(command.type === 'session-start' && command.server).toBe('registration-gpu-box-01');
  });

  it('a whitespace prompt is the absence of a prompt: the wire refuses an empty string', () => {
    expect(parsePrompt('   ')).toBeNull();
    const parsed = parseClientFrame({ ...buildStart(AGENTPLEX, 'claude', null, '   '), id: 1 });
    expect(parsed.ok && parsed.value.type === 'session-start' && parsed.value.prompt).toBeNull();
  });
});

describe('submit', () => {
  /** The one machine in the single fixture runs both providers, both ready. */
  const both = providerOffer(single, AGENTPLEX, null);

  it('is blocked while disconnected, with the phase in words', () => {
    expect(submitBlockedReason('reconnecting', [AGENTPLEX], AGENTPLEX, both, 'claude')).toBe(
      'the connection to the hub is down; reconnecting',
    );
    expect(submitBlockedReason('connecting', [AGENTPLEX], AGENTPLEX, both, 'claude')).toBe(
      'still connecting to the hub',
    );
    expect(submitBlockedReason('failed', [AGENTPLEX], AGENTPLEX, both, 'claude')).toBe(
      'the connection has failed and is not retrying',
    );
  });

  it('is blocked with no store, and while none of several is chosen', () => {
    expect(submitBlockedReason('connected', [], null, NOTHING, null)).toBe(
      'no paired server reports a store to start in',
    );
    expect(submitBlockedReason('connected', startableStores(populated), null, NOTHING, null)).toBe(
      'choose a store to start in',
    );
  });

  it('is blocked while none of several providers is chosen', () => {
    expect(submitBlockedReason('connected', [AGENTPLEX], AGENTPLEX, both, null)).toBe(
      'choose a provider to run',
    );
  });

  it('is blocked when nothing on offer can start, above the reasons why', () => {
    // One sentence for the button, naming the two controls above it; what to
    // go and do is in `problems`, in each machine's own words.
    expect(
      submitBlockedReason('connected', [MIXED], MIXED, providerOffer(mixed, MIXED, MINI), null),
    ).toBe('no provider can be started with these choices');
  });

  it('is allowed with a connection, a store and a provider', () => {
    expect(submitBlockedReason('connected', [AGENTPLEX], AGENTPLEX, both, 'claude')).toBeNull();
  });

  it('a queued delivery is said in words; a sent one needs none', () => {
    expect(deliveryWords('queued')).toBe(
      'the connection is down; the start is queued and will be sent when it returns',
    );
    expect(deliveryWords('sent')).toBeNull();
  });
});

describe('the follow-up to a start', () => {
  const started = startedFrom(hubFrames.sessionStarted);

  it('waits while no answer names the command', () => {
    expect(startFollowUp(started.replyTo, null, null, single, null)).toEqual({ kind: 'waiting' });
  });

  it("ignores an answer to somebody else's command", () => {
    const other = frameIdSchema.parse(99);
    expect(startFollowUp(other, started, null, single, null)).toEqual({ kind: 'waiting' });
  });

  it('a fresh spawn is said in words, naming the machine the hub picked', () => {
    // The captured reply's sessionId is null: the provider has not written an
    // id yet, so there is no pane address to navigate to -- inventing one would
    // give a page that never matches the id the provider mints.
    expect(started.sessionId).toBeNull();
    expect(startFollowUp(started.replyTo, started, null, single, null)).toEqual({
      kind: 'started',
      words:
        'started on mbp-robert; the session appears in the list once the provider writes its first turn',
    });
  });

  it('navigates immediately when the reply names the session', () => {
    const resumed: StartedView = {
      ...started,
      sessionId: single.stores[0]?.sessions[0]?.descriptor.sessionId ?? null,
    };
    expect(startFollowUp(started.replyTo, resumed, null, single, null)).toEqual({
      kind: 'navigate',
      hash: '#/session/store-agentplex/session-fix-auth',
    });
  });

  it("a refusal surfaces the hub's own words", () => {
    const parsed = parseTextFrame(parseHubFrame, hubFrames.refusal);
    if (!parsed.ok || parsed.value.type !== 'refusal') throw new Error('not a refusal fixture');
    const refusal: RefusalView = {
      replyTo: parsed.value.replyTo,
      code: parsed.value.code,
      message: parsed.value.message,
      holder: parsed.value.holder,
    };
    expect(startFollowUp(refusal.replyTo, null, refusal, single, null)).toEqual({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
      held: null,
    });
  });

  it('names the machine when the refusal says the session is already running', () => {
    // Captured from a real hub refusing a real start on a session another
    // process was holding. The machine is named from the state through the
    // lookup the list uses, not read out of the hub's sentence.
    const refusal = refusalFrom(hubFrames.refusalHeldStoppable);
    const followUp = startFollowUp(refusal.replyTo, null, refusal, populated, null);

    expect(followUp).toEqual({
      kind: 'refused',
      words: 'that session is already running on mbp-robert',
      held: {
        holder: { server: 'registration-mbp-robert', stoppable: true, pause: 'none' },
        machine: 'mbp-robert',
        session: null,
      },
    });
  });

  it('aims the way out at the session the start named, when it named one', () => {
    // `session` is what a stop is addressed to, and it is the start's own
    // subject: only a start that names a session can be refused for one being
    // held. This flow sends none today, so the field is `null` above.
    const refusal = refusalFrom(hubFrames.refusalHeldStoppable);
    const asked = sessionRefSchema.parse({
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
    const followUp = startFollowUp(refusal.replyTo, null, refusal, populated, asked);

    expect(followUp.kind === 'refused' ? followUp.held?.session : null).toEqual(asked);
  });

  it('falls back to the registration id before any state describes the machine', () => {
    const refusal = refusalFrom(hubFrames.refusalHeldStoppable);
    const followUp = startFollowUp(refusal.replyTo, null, refusal, null, null);

    expect(followUp.kind === 'refused' ? followUp.held?.machine : null).toBe(
      'registration-mbp-robert',
    );
  });
});

describe('the pane address', () => {
  it('percent-escapes each segment: an opaque id may contain any separator', () => {
    const sessionId = single.stores[0]?.sessions[0]?.descriptor.sessionId;
    if (sessionId === undefined) throw new Error('the single fixture has no session');
    expect(sessionPaneHash({ storeId: storeIdSchema.parse('store/one'), sessionId })).toBe(
      '#/session/store%2Fone/session-fix-auth',
    );
  });
});
