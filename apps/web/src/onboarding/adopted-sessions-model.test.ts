import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { sessionsOnServer } from './adopted-sessions-model.js';

/**
 * Every state here is a captured machine-state frame read back through the
 * same parser the store uses. The wizard's closing screen is a report of what
 * the hub already knows about one machine, so a hand-written state would only
 * prove the report can read what its author imagined.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.value.type !== 'machine-state') throw new Error(`captured a ${parsed.value.type}`);
  return parsed.value.state;
}

/**
 * A registration id as the capture spells it, found by the label a person
 * would read. Ids are branded, and a literal cast here would be the test
 * asserting what a registration id is rather than the frame saying it.
 */
function registrationFor(state: MachineState, label: string): ServerRegistrationId {
  const server = state.servers.find((view) => view.label === label);
  if (server === undefined) throw new Error(`the capture names no machine called ${label}`);
  return server.registrationId;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const justPaired = stateFrom(hubFrames.machineStateJustPaired);
const shared = stateFrom(hubFrames.machineStateShared);

const mbpRobert = registrationFor(populated, 'mbp-robert');
const gpuBox = registrationFor(populated, 'gpu-box-01');
/** A real id from another capture, which the populated state does not name. */
const strangerToPopulated = registrationFor(justPaired, 'mbp-robert');

describe('the sessions a machine brought with it', () => {
  it('reports every session on the machine, last activity first', () => {
    expect(sessionsOnServer(populated, mbpRobert)).toEqual([
      {
        ref: { storeId: 'store-agentplex', sessionId: 'session-migrate-db' },
        name: 'migrate-db-v9',
        provider: 'codex',
        cwd: '/Users/robert/code/agentplex/db',
        activity: 'awaiting permission',
        updatedAt: 1755999820000,
      },
      {
        ref: { storeId: 'store-agentplex', sessionId: 'session-fix-auth' },
        name: 'fix-auth-refresh',
        provider: 'claude',
        cwd: '/Users/robert/code/agentplex',
        activity: 'working',
        updatedAt: 1755999280000,
      },
      {
        ref: { storeId: 'store-agentplex', sessionId: 'session-spike-wasm' },
        name: 'spike-wasm',
        provider: 'claude',
        cwd: null,
        activity: 'idle',
        updatedAt: 1755992800000,
      },
    ]);
  });

  it('leaves a session with no working directory at null rather than filling it in', () => {
    // The card list substitutes the status words for an absent cwd, because a
    // card needs a body. This report has a column for the activity already, so
    // the substitution would put the same word in two places and claim a
    // directory the provider never recorded.
    const spike = sessionsOnServer(populated, mbpRobert).find(
      (item) => item.ref.sessionId === 'session-spike-wasm',
    );
    expect(spike?.cwd).toBeNull();
    expect(spike?.activity).toBe('idle');
  });

  it('reports nothing for a machine whose stores hold no sessions yet', () => {
    expect(sessionsOnServer(justPaired, registrationFor(justPaired, 'mbp-robert'))).toEqual([]);
  });

  it('reports nothing before the hub has published a state at all', () => {
    // The screen above holds the store's snapshot, whose state is null until
    // the first broadcast lands -- the same null `serverRows` and
    // `discoveredCandidates` take. Nothing found is the honest reading of a
    // hub that has not said anything yet.
    expect(sessionsOnServer(null, mbpRobert)).toEqual([]);
  });

  it('reports nothing for a machine the state does not name', () => {
    expect(sessionsOnServer(populated, strangerToPopulated)).toEqual([]);
  });

  it('leaves another machine out, even one mounting the same store', () => {
    expect(sessionsOnServer(populated, gpuBox).map((item) => item.name)).toEqual([
      'docs-sweep',
      'bench-tokenizer',
      'session-train-lora',
    ]);
  });

  it('counts a shared store once, against the machine whose reading this is', () => {
    // Two machines have this volume mounted and both report the session. The
    // hub picks one reading; attributing it to every reporter would tell a
    // first-run reader their new machine found work that is already on screen
    // under another machine's name.
    expect(
      sessionsOnServer(shared, registrationFor(shared, 'gpu-box-01')).map((item) => item.name),
    ).toEqual(['shared-notes']);
    expect(sessionsOnServer(shared, registrationFor(shared, 'mbp-robert'))).toEqual([]);
  });
});
