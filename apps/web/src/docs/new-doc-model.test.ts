import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { DocCreatedView, RefusalView } from '../store/hub-store.js';
import {
  buildDocCreate,
  docCreateBlockedReason,
  docCreateFollowUp,
  parseDocName,
  writableServers,
} from './new-doc-model.js';

/**
 * The New doc rules, against states a real hub broadcast and a name schema the
 * hub shares with the machine that writes the file.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const shared = stateFrom(hubFrames.machineStateShared);
const sharedDegraded = stateFrom(hubFrames.machineStateSharedDegraded);
const empty = stateFrom(hubFrames.machineState);
const MACHINE = serverRegistrationIdSchema.parse('registration-mbp-robert');
const PROJECT = nodeIdSchema.parse('hub-4');

describe('which machine may hold a new document', () => {
  it('offers every connected machine', () => {
    expect(writableServers(shared).map((choice) => choice.label)).toEqual([
      'gpu-box-01',
      'mbp-robert',
    ]);
  });

  it('drops a machine that has gone away, whatever its rows still say', () => {
    // The hub keeps a stale machine's rows so the fleet stays legible; a
    // create aimed at one can only be refused, so it is not offered.
    expect(writableServers(sharedDegraded).map((choice) => choice.label)).toEqual(['mbp-robert']);
    expect(writableServers(empty)).toEqual([]);
    expect(writableServers(null)).toEqual([]);
  });
});

describe('what a document may be called', () => {
  it('takes a name the protocol takes, trimming what the typing added', () => {
    expect(parseDocName('  plan.md ')).toEqual({ ok: true, name: 'plan.md' });
    expect(parseDocName('README.md')).toEqual({ ok: true, name: 'README.md' });
  });

  it('refuses a traversal before it costs a round trip, in the schema words', () => {
    const escaped = parseDocName('../secrets.md');
    expect(escaped.ok).toBe(false);
    expect(escaped.ok ? '' : escaped.problem).toContain('two dots in a row');
  });

  it('refuses an extension the store is not for, and a blank', () => {
    const executable = parseDocName('plan.sh');
    expect(executable.ok).toBe(false);
    expect(executable.ok ? '' : executable.problem).toContain('.md');
    expect(parseDocName('   ')).toEqual({ ok: false, problem: 'give the document a name' });
  });
});

describe('the create the form sends', () => {
  it('is a frame the hub can parse, with an empty first document', () => {
    const name = parseDocName('plan.md');
    if (!name.ok) throw new Error('plan.md is a document name');
    const command = buildDocCreate(PROJECT, MACHINE, name.name);
    const frame = parseTextFrame(
      parseClientFrame,
      JSON.stringify({ ...command, id: frameIdSchema.parse(1) }),
    );
    expect(frame.ok).toBe(true);
    expect(command).toEqual({
      type: 'doc-create',
      projectId: 'hub-4',
      server: 'registration-mbp-robert',
      name: 'plan.md',
      content: '',
    });
  });
});

describe('why the create is disabled', () => {
  it('names the connection before it names the form', () => {
    expect(docCreateBlockedReason('reconnecting', 'plan.md', MACHINE)).toBe(
      'the connection to the hub is down; reconnecting',
    );
    expect(docCreateBlockedReason('failed', 'plan.md', MACHINE)).toBe(
      'the connection has failed and is not retrying',
    );
  });

  it('names the name, then the machine, then says nothing', () => {
    expect(docCreateBlockedReason('connected', '', MACHINE)).toBe('give the document a name');
    expect(docCreateBlockedReason('connected', 'plan.md', null)).toBe(
      'pick the machine this document lives on',
    );
    expect(docCreateBlockedReason('connected', 'plan.md', MACHINE)).toBeNull();
  });
});

describe('what the hub said about the create', () => {
  const pending = frameIdSchema.parse(8);
  const created: DocCreatedView = { replyTo: pending, nodeId: nodeIdSchema.parse('hub-5') };
  const refusal: RefusalView = {
    replyTo: pending,
    code: 'refused',
    message: 'that project already has a document called plan.md on mbp-robert',
    holder: null,
  };

  it('waits until an answer names this frame', () => {
    expect(docCreateFollowUp(pending, null, null)).toEqual({ kind: 'waiting' });
    expect(
      docCreateFollowUp(pending, { ...created, replyTo: frameIdSchema.parse(9) }, null),
    ).toEqual({ kind: 'waiting' });
  });

  it('carries the node a made document is named by from then on', () => {
    expect(docCreateFollowUp(pending, created, null)).toEqual({ kind: 'made', nodeId: 'hub-5' });
  });

  it('renders the hub sentence when the answer was no', () => {
    expect(docCreateFollowUp(pending, null, refusal)).toEqual({
      kind: 'refused',
      words: refusal.message,
    });
  });
});
