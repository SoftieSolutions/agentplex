import { describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  frameIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type Layout,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { answersOf, replyFrom, withOutstanding } from '../store/replies.fixture.js';
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
  // A thin mapping over `followUp`: each of its answers, renamed.
  const created = replyFrom(hubFrames.projectCreated, 'project-created');
  const pending = created.replyTo;

  it('waits while nothing has answered this create', () => {
    expect(createFollowUp(pending, withOutstanding(answersOf(), pending)).kind).toBe('waiting');
  });

  it('is idle once this create is neither answered nor owed an answer', () => {
    // Its answer was pushed out by later ones, or the connection it went out
    // on dropped: nothing is coming, and a form that went on waiting would
    // stay disabled until it was closed.
    expect(createFollowUp(pending, answersOf()).kind).toBe('idle');
  });

  it('ignores an answer to somebody else’s frame', () => {
    const other = { ...created, replyTo: frameIdSchema.parse(9) };
    expect(createFollowUp(pending, withOutstanding(answersOf(other), pending)).kind).toBe(
      'waiting',
    );
  });

  it('says so when the project was made', () => {
    expect(createFollowUp(pending, answersOf(created)).kind).toBe('made');
  });

  it('shows the hub’s own words when it refused', () => {
    const refusal = replyFrom(hubFrames.refusal, 'refusal');
    expect(createFollowUp(refusal.replyTo, answersOf(refusal))).toEqual({
      kind: 'refused',
      words: refusal.message,
    });
  });
});

describe('the projects a picker offers', () => {
  /**
   * The captured tree with one more project beside the one the capture made,
   * named HOME by a person: a copy of the captured project node with its own
   * id, so every field but the two that tell it apart is what the hub sent.
   * HOME is told by its id and never by its name, and this is the project
   * that would catch a picker that read the name instead.
   */
  const captured = withProject.find((node) => node.id === 'hub-5');
  if (captured === undefined) throw new Error('the capture made no project');
  const namedHome = {
    ...captured,
    id: nodeIdSchema.parse('hub-90'),
    position: 2,
    name: 'HOME',
  };
  const withTwoProjects: Layout = [...withProject, namedHome];

  it('lists HOME first when the picker takes it, then the rest in the hub order', () => {
    // HOME first, because the hub sends it first: migration 0020 seeds it at
    // the root's position 0.
    expect(projectChoices(withTwoProjects, { includeHome: true })).toEqual([
      { id: HOME_PROJECT_ID, label: 'HOME' },
      { id: 'hub-5', label: 'agentplex (main checkout)' },
      { id: 'hub-90', label: 'HOME' },
    ]);
  });

  it('leaves HOME out where the hub would refuse it, and keeps a project merely named HOME', () => {
    expect(projectChoices(withTwoProjects, { includeHome: false })).toEqual([
      { id: 'hub-5', label: 'agentplex (main checkout)' },
      { id: 'hub-90', label: 'HOME' },
    ]);
  });

  it('offers nothing before a tree has arrived', () => {
    expect(projectChoices(null, { includeHome: true })).toEqual([]);
    expect(projectChoices(null, { includeHome: false })).toEqual([]);
  });

  it('passes over every node that is not a project', () => {
    // The same captured tree holds two session nodes. A picker that offered one
    // would be offering a start inside a session.
    expect(withProject.filter((node) => node.kind === 'session').length).toBeGreaterThan(0);
    const projects = withProject.filter((node) => node.kind === 'project');
    expect(projectChoices(withProject, { includeHome: true })).toHaveLength(projects.length);
  });
});
