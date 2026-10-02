import { describe, expect, it } from 'vitest';
import {
  destinationHash,
  NAV,
  parseDestinationHash,
  parseSettingsSectionHash,
  resolveDestination,
  resolveSettingsSection,
  settingsSectionHash,
  settingsSections,
  SETTINGS_SECTIONS,
  TABS,
} from './destinations.js';

/**
 * What an address means to the shell, and what the shell is willing to draw a
 * way to. Both are decided here rather than in a component, so neither needs a
 * DOM to be pinned.
 */

describe('the destination an address names', () => {
  it('reads back every address the shell writes', () => {
    expect(parseDestinationHash(destinationHash('settings'))).toBe('settings');
    expect(parseDestinationHash(destinationHash('sessions'))).toBe('sessions');
    expect(parseDestinationHash(destinationHash('projects'))).toBe('projects');
    expect(parseDestinationHash(destinationHash('more'))).toBe('more');
  });

  it('opens on the session list, which is what an empty hash means', () => {
    expect(parseDestinationHash('')).toBe('sessions');
    expect(parseDestinationHash('#')).toBe('sessions');
  });

  it('answers the session list for an address it does not recognize', () => {
    // Typed, pasted, or left over from a version of the app that had a place
    // this one does not. None of them is an error; all of them are the list.
    expect(parseDestinationHash('#/graphs')).toBe('sessions');
    expect(parseDestinationHash('#/projects/tree')).toBe('sessions');
    // Settings owns its three section addresses exactly, not every path under
    // it: a path naming no section is an address this app never wrote.
    expect(parseDestinationHash('#/settings/pairing')).toBe('sessions');
    expect(parseDestinationHash('#/settings/')).toBe('sessions');
    expect(parseDestinationHash('#/session/store-1/session-1')).toBe('sessions');
  });
});

describe('the nav at the foot of the sidebar', () => {
  it('offers only destinations that exist', () => {
    expect(NAV.map((entry) => entry.destination)).toEqual(['settings']);
  });

  it('draws nothing for graphs or the library, which are not built', () => {
    expect(NAV.map((entry) => entry.label)).not.toContain('Graphs');
    expect(NAV.map((entry) => entry.label)).not.toContain('Library');
  });
});

describe('the tab bar at the foot of the phone chrome', () => {
  it('offers the places the phone can go, in the mockup order', () => {
    expect(TABS.map((tab) => tab.label)).toEqual(['Sessions', 'Projects', 'More']);
  });

  it('draws nothing for graphs, which are not built', () => {
    // The mockup's fourth tab. The rule the nav follows is the rule here: a
    // tab onto nothing is a promise the app cannot keep.
    expect(TABS.map((tab) => tab.label)).not.toContain('Graphs');
  });

  it('sends every tab to an address the parser reads back', () => {
    for (const tab of TABS) {
      expect(parseDestinationHash(destinationHash(tab.destination))).toBe(tab.destination);
    }
  });
});

describe('what an address means in each form of the shell', () => {
  it('leaves the phone chrome every place its tab bar offers', () => {
    expect(resolveDestination('sessions', 'phone')).toBe('sessions');
    expect(resolveDestination('projects', 'phone')).toBe('projects');
    expect(resolveDestination('more', 'phone')).toBe('more');
    expect(resolveDestination('settings', 'phone')).toBe('settings');
  });

  it('answers the desk chrome the session list for the two places its sidebar already is', () => {
    // The tree and the nav are on screen at every moment on a wide screen, so
    // a content region holding either would be a second copy of what is
    // beside it. Both addresses stay readable -- pasted, bookmarked, or left
    // over from a phone -- and both land on the list the sidebar sits next to.
    expect(resolveDestination('projects', 'wide')).toBe('sessions');
    expect(resolveDestination('more', 'wide')).toBe('sessions');
  });

  it('is the same route model in both forms for every other address', () => {
    expect(resolveDestination('settings', 'wide')).toBe('settings');
    expect(resolveDestination('sessions', 'wide')).toBe('sessions');
  });
});

describe('the sections of the settings screen', () => {
  it('reads every section address, and plain settings, as the settings destination', () => {
    expect(parseDestinationHash('#/settings')).toBe('settings');
    expect(parseDestinationHash('#/settings/connections')).toBe('settings');
    expect(parseDestinationHash('#/settings/preferences')).toBe('settings');
    expect(parseDestinationHash('#/settings/developer')).toBe('settings');
  });

  it('names the section each settings address opens on, Connections when it names none', () => {
    expect(parseSettingsSectionHash('#/settings')).toBe('connections');
    expect(parseSettingsSectionHash('#/settings/connections')).toBe('connections');
    expect(parseSettingsSectionHash('#/settings/preferences')).toBe('preferences');
    expect(parseSettingsSectionHash('#/settings/developer')).toBe('developer');
    expect(parseSettingsSectionHash('#/settings/nonsense')).toBe('connections');
    expect(parseSettingsSectionHash('')).toBe('connections');
  });

  it('reads back every section address it writes', () => {
    for (const { section } of SETTINGS_SECTIONS) {
      expect(settingsSectionHash(section)).toBe(`#/settings/${section}`);
      expect(parseSettingsSectionHash(settingsSectionHash(section))).toBe(section);
      expect(parseDestinationHash(settingsSectionHash(section))).toBe('settings');
    }
  });

  it('offers Connections, Preferences and Developer, in that order', () => {
    expect(settingsSections(true).map((entry) => entry.label)).toEqual([
      'Connections',
      'Preferences',
      'Developer',
    ]);
  });

  it('offers no Developer section when there is no switch for it to hold', () => {
    expect(settingsSections(false).map((entry) => entry.label)).toEqual([
      'Connections',
      'Preferences',
    ]);
  });

  it('opens Connections for a Developer address with no switch behind it', () => {
    expect(resolveSettingsSection('developer', false)).toBe('connections');
    expect(resolveSettingsSection('developer', true)).toBe('developer');
    expect(resolveSettingsSection('preferences', false)).toBe('preferences');
    expect(resolveSettingsSection('connections', true)).toBe('connections');
  });
});
