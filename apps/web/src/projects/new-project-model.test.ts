import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type Layout,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { ProjectCreatedView, RefusalView } from '../store/hub-store.js';
import {
  browsableServers,
  buildProjectCreate,
  createBlockedReason,
  createFollowUp,
  parseProjectName,
  projectChoices,
} from './new-project-model.js';

/**
 * The new-project flow's rules against captured hub output.
 *
 * Every state and every reply here came off a real hub over a real websocket
 * (hub-frames.fixture.ts), including the tree with a project in it: the project
 * picker's rule is about a node kind, and a hand-written layout would be
 * testing its author's idea of what the hub sends.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

function layoutFrom(text: string): Layout {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'layout') {
    throw new Error('the fixture is not a layout frame');
  }
  return parsed.value.nodes;
}

const shared = stateFrom(hubFrames.machineStateShared);
const sharedDegraded = stateFrom(hubFrames.machineStateSharedDegraded);
const empty = stateFrom(hubFrames.machineState);
const withProject = layoutFrom(hubFrames.layoutWithProject);

describe('which machine is being browsed', () => {
  it('offers every connected machine, one or many', () => {
    // Unlike the session form's override, one candidate is still drawn: it is
    // not a choice between machines, it is the answer to whose disk this is.
    expect(browsableServers(shared).map((choice) => choice.label)).toEqual([
      'gpu-box-01',
      'mbp-robert',
    ]);
    expect(browsableServers(sharedDegraded).map((choice) => choice.label)).toEqual(['mbp-robert']);
  });

  it('offers none when nothing is connected, rather than a choice that can only be refused', () => {
    expect(browsableServers(empty)).toEqual([]);
    expect(browsableServers(null)).toEqual([]);
  });
});

describe('the frame', () => {
  it('builds a project-create the protocol parser accepts, exactly as typed', () => {
    const command = buildProjectCreate('  agentplex  ', '/Users/robert/code/agentplex');
    const parsed = parseClientFrame({ ...command, id: 7 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toEqual({
      type: 'project-create',
      id: 7,
      name: 'agentplex',
      directory: '/Users/robert/code/agentplex',
    });
  });

  it('names no server, because a project is not tied to one', () => {
    // The machine picked in the form is the machine being browsed. The frame
    // has nowhere to put it, and that is the decision rather than an omission.
    const command = buildProjectCreate('agentplex', '/Users/robert/code/agentplex');
    expect(Object.keys(command).sort()).toEqual(['directory', 'name', 'type']);
  });

  it('reads a name of nothing but spaces as the absence of a name', () => {
    expect(parseProjectName('   ')).toBeNull();
    expect(parseProjectName('  agentplex ')).toBe('agentplex');
  });
});

describe('why submit is disabled', () => {
  it('says the connection is down before it says anything about the form', () => {
    expect(createBlockedReason('reconnecting', '', null)).toContain('down');
    expect(createBlockedReason('failed', 'agentplex', '/srv/work')).toContain('failed');
  });

  it('asks for the name and then for the directory, in that order', () => {
    expect(createBlockedReason('connected', '  ', '/srv/work')).toContain('name');
    expect(createBlockedReason('connected', 'agentplex', null)).toContain('directory');
  });

  it('blocks nothing once both are answered', () => {
    expect(createBlockedReason('connected', 'agentplex', '/srv/work')).toBeNull();
  });
});

describe('what the form does with the answer', () => {
  const pending = frameIdSchema.parse(5);
  const created: ProjectCreatedView = {
    replyTo: pending,
    nodeId: nodeIdSchema.parse('hub-5'),
  };

  it('waits while nothing has answered this create', () => {
    expect(createFollowUp(pending, null, null).kind).toBe('waiting');
  });

  it('ignores an answer to somebody else’s frame', () => {
    const other: ProjectCreatedView = { ...created, replyTo: frameIdSchema.parse(9) };
    expect(createFollowUp(pending, other, null).kind).toBe('waiting');
  });

  it('says so when the project was made', () => {
    expect(createFollowUp(pending, created, null).kind).toBe('made');
  });

  it('shows the hub’s own words when it refused', () => {
    const refusal: RefusalView = {
      replyTo: pending,
      code: 'refused',
      message: 'there is already a project at /srv/work',
      holder: null,
    };
    expect(createFollowUp(pending, null, refusal)).toEqual({
      kind: 'refused',
      words: 'there is already a project at /srv/work',
    });
  });
});

describe('the projects a picker offers', () => {
  it('reads them off the tree, by kind, in the order the hub sent them', () => {
    expect(projectChoices(withProject)).toEqual([
      { id: 'hub-5', label: 'agentplex (main checkout)' },
    ]);
  });

  it('offers nothing before a tree has arrived', () => {
    expect(projectChoices(null)).toEqual([]);
  });

  it('passes over every node that is not a project', () => {
    // The same captured tree holds two session nodes. A picker that offered one
    // would be offering a start inside a session.
    expect(withProject.filter((node) => node.kind === 'session').length).toBeGreaterThan(0);
    expect(projectChoices(withProject)).toHaveLength(1);
  });
});
