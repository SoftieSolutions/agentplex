import { describe, expect, it } from 'vitest';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { NEW_NODE_KINDS, newMenu, type NewNodeRow } from './new-menu-model.js';

/**
 * What the New button offers, decided here rather than in the popover, so the
 * rule can be pinned without a DOM and so the one table saying what is built
 * has one test saying what that means.
 */

function kindsOf(rows: readonly { readonly kind: string }[]): readonly string[] {
  return rows.map((row) => row.kind);
}

describe('the table of node kinds', () => {
  it('lists every kind the mock draws, built or not', () => {
    // The unbuilt kinds are rows here and absent from the menu. Keeping them
    // in the table is what makes AGX-145 (Graph) and AGX-149 (Agent) a flag
    // flip in one file rather than a new entry invented from the mock again.
    expect(kindsOf(NEW_NODE_KINDS)).toEqual(['session', 'project', 'graph', 'agent', 'machine']);
  });

  it('has nothing behind Graph and Agent yet', () => {
    const unbuilt = NEW_NODE_KINDS.filter((row) => !row.built);
    expect(kindsOf(unbuilt)).toEqual(['graph', 'agent']);
  });
});

describe('the menu the New button offers', () => {
  it('offers Session, Project and Enroll machine, and nothing else', () => {
    // Absent, not disabled: a greyed row with a tooltip is a promise the app
    // cannot keep, and there is no date behind it.
    expect(kindsOf(newMenu().entries)).toEqual(['session', 'project', 'machine']);
  });

  it('words every entry as the mock words it', () => {
    expect(
      newMenu().entries.map((entry) => ({ label: entry.label, description: entry.description })),
    ).toEqual([
      { label: 'Session', description: 'Start an agent in a repo' },
      { label: 'Project', description: 'Group repos and sessions' },
      { label: 'Enroll machine', description: 'One command, adopts running sessions' },
    ]);
  });

  it('sends Enroll machine to the wizard, which is the only entry that is an address', () => {
    expect(newMenu().entries.map((entry) => entry.href)).toEqual([
      undefined,
      undefined,
      ONBOARDING_HASH,
    ]);
  });
});

describe('the shortcut hints', () => {
  it('draws the chord the mock draws', () => {
    const hints = NEW_NODE_KINDS.map((row) => [row.kind, row.hint?.text] as const);
    expect(hints).toEqual([
      ['session', '⌘N'],
      ['project', undefined],
      ['graph', '⌘G'],
      ['agent', undefined],
      ['machine', undefined],
    ]);
  });

  it('marks every hint unbound, because nothing registers these chords', () => {
    // Placeholder UI by decision: AGX-260 decides the real chords and binds
    // them. Until it does, a hint is text, and a test that reads `bound` is
    // the thing that fails when somebody draws a hint that lies.
    const bound = NEW_NODE_KINDS.flatMap((row) => (row.hint ? [row.hint.bound] : []));
    expect(bound).toEqual([false, false]);
  });
});

describe('the mode the button is in', () => {
  const session: NewNodeRow = {
    kind: 'session',
    label: 'Session',
    description: 'Start an agent in a repo',
    built: true,
  };
  const project: NewNodeRow = {
    kind: 'project',
    label: 'Project',
    description: 'Group repos and sessions',
    built: true,
  };

  it('is a menu while more than one kind is built', () => {
    expect(newMenu().mode).toBe('menu');
    expect(newMenu([session, project]).mode).toBe('menu');
  });

  it('is direct when one kind is built, because a menu of one is a menu of none', () => {
    const menu = newMenu([session, { ...project, built: false }]);
    expect(menu.mode).toBe('direct');
    expect(kindsOf(menu.entries)).toEqual(['session']);
  });
});
