import { describe, expect, it } from 'vitest';
import { serverRegistrationIdSchema, type DirectoryEntry } from '@agentplex/protocol';
import type { DirectoryListingView, HubSnapshot, RefusalView } from '../store/hub-store.js';
import {
  breadcrumb,
  browseFor,
  chooseBlockedReason,
  descendTo,
  pickerView,
  refusalWords,
  truncationNotice,
} from './directory-picker-model.js';

const WORK = '/srv/work';
const SERVER = serverRegistrationIdSchema.parse('registration-mbp');

function listing(over: Partial<DirectoryListingView> = {}): DirectoryListingView {
  return {
    replyTo: 2,
    directory: WORK,
    roots: [WORK],
    entries: [],
    truncated: false,
    ...over,
  };
}

function snapshot(over: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    phase: 'connected',
    problem: null,
    hubId: null,
    machineState: null,
    layout: null,
    paneLayout: null,
    commandQueue: { queued: 0, capacity: 32, overflowed: null },
    terminalInput: { discarded: 0, notice: null },
    lastRefusal: null,
    lastStarted: null,
    lastListing: null,
    ...over,
  };
}

function refusal(over: Partial<RefusalView> = {}): RefusalView {
  return {
    replyTo: 2,
    code: 'refused',
    message: '/etc is not under a directory this server will browse',
    holder: null,
    ...over,
  };
}

const directory = (name: string): DirectoryEntry => ({ name, kind: 'directory' });

describe('descendTo', () => {
  it('takes a root entry as the absolute path it already is', () => {
    // The one case a join would break: there is no parent above a root, which
    // is exactly why the reply carries `directory: null` there.
    expect(descendTo(listing({ directory: null }), directory(WORK))).toBe(WORK);
  });

  it('joins a segment onto the directory that was listed', () => {
    expect(descendTo(listing(), directory('agentplex'))).toBe(`${WORK}/agentplex`);
  });

  it('does not double the separator on a directory that ends in one', () => {
    expect(descendTo(listing({ directory: '/' }), directory('srv'))).toBe('/srv');
  });

  it('offers no path for a file or a link, which the server would refuse', () => {
    expect(descendTo(listing(), { name: 'notes.md', kind: 'file' })).toBeNull();
    expect(descendTo(listing(), { name: 'current', kind: 'other' })).toBeNull();
  });
});

describe('breadcrumb', () => {
  it('starts at the roots, whatever is being shown', () => {
    expect(breadcrumb(null, [WORK, '/opt/src'])[0]).toEqual({ label: 'roots', directory: null });
  });

  it('names the first step for how many roots there are', () => {
    expect(breadcrumb(null, [WORK])[0]?.label).toBe('root');
  });

  it('stops at the root a directory sits under, not at the filesystem root', () => {
    // Every step above a root would be refused, and an unclickable left half
    // is a breadcrumb that lies about where you can go.
    expect(breadcrumb(`${WORK}/agentplex/apps`, [WORK])).toEqual([
      { label: 'root', directory: null },
      { label: WORK, directory: WORK },
      { label: 'agentplex', directory: `${WORK}/agentplex` },
      { label: 'apps', directory: `${WORK}/agentplex/apps` },
    ]);
  });

  it('picks the root the directory is actually under when there are several', () => {
    expect(breadcrumb('/opt/src/thing', [WORK, '/opt/src'])).toEqual([
      { label: 'roots', directory: null },
      { label: '/opt/src', directory: '/opt/src' },
      { label: 'thing', directory: '/opt/src/thing' },
    ]);
  });

  it('does not mistake a sibling for a root by prefix alone', () => {
    // `/srv/work-secrets` is not under `/srv/work`, and the server would say
    // so; the breadcrumb must not claim otherwise on its way there.
    expect(breadcrumb('/srv/work-secrets', [WORK])).toEqual([
      { label: 'root', directory: null },
      { label: '/srv/work-secrets', directory: '/srv/work-secrets' },
    ]);
  });

  it('shows the root itself as two steps: the roots, and it', () => {
    expect(breadcrumb(WORK, [WORK])).toEqual([
      { label: 'root', directory: null },
      { label: WORK, directory: WORK },
    ]);
  });
});

describe('browseFor', () => {
  it('names the server and the directory, and nothing else', () => {
    expect(browseFor(SERVER, null)).toEqual({
      type: 'directory-list',
      server: SERVER,
      directory: null,
    });
    expect(browseFor(SERVER, WORK).directory).toBe(WORK);
  });
});

describe('pickerView', () => {
  it('is idle before anything has been asked', () => {
    expect(pickerView(snapshot(), null)).toEqual({ kind: 'idle' });
  });

  it('waits while the question has no answer', () => {
    expect(pickerView(snapshot(), 2)).toEqual({ kind: 'waiting' });
  });

  it('shows the listing that answers this question', () => {
    const answer = listing({ replyTo: 2 });
    expect(pickerView(snapshot({ lastListing: answer }), 2)).toEqual({
      kind: 'listing',
      listing: answer,
    });
  });

  it('ignores an answer to an earlier question', () => {
    // A user who clicks twice while a slow disk answers must not see the first
    // directory rendered under the second one's breadcrumb.
    expect(pickerView(snapshot({ lastListing: listing({ replyTo: 2 }) }), 3)).toEqual({
      kind: 'waiting',
    });
  });

  it('shows a refusal that answers this question', () => {
    expect(pickerView(snapshot({ lastRefusal: refusal({ replyTo: 2 }) }), 2)).toEqual({
      kind: 'refused',
      words: '/etc is not under a directory this server will browse',
    });
  });

  it('ignores a refusal about somebody else’s frame', () => {
    expect(pickerView(snapshot({ lastRefusal: refusal({ replyTo: 9 }) }), 2).kind).toBe('waiting');
  });
});

describe('refusalWords', () => {
  it('passes the hub’s own sentence through', () => {
    expect(refusalWords(refusal())).toBe('/etc is not under a directory this server will browse');
  });

  it('adds the one thing the message cannot say about itself', () => {
    expect(
      refusalWords(refusal({ code: 'internal', message: 'this server could not read /srv/work' })),
    ).toBe('this server could not read /srv/work. Trying again may work.');
  });
});

describe('truncationNotice', () => {
  it('says nothing about a whole listing', () => {
    expect(truncationNotice(listing())).toBeNull();
  });

  it('says how many are shown, so a prefix is not read as the whole', () => {
    const cut = listing({ truncated: true, entries: [directory('a'), directory('b')] });
    expect(truncationNotice(cut)).toContain('first 2 entries');
  });
});

describe('chooseBlockedReason', () => {
  it('blocks while nothing is listed', () => {
    expect(chooseBlockedReason({ kind: 'waiting' })).toBe('nothing is listed yet');
  });

  it('blocks on the roots listing, which is a question and not a directory', () => {
    expect(
      chooseBlockedReason({ kind: 'listing', listing: listing({ directory: null }) }),
    ).toContain('choose one');
  });

  it('allows a directory that was actually listed', () => {
    expect(chooseBlockedReason({ kind: 'listing', listing: listing() })).toBeNull();
  });
});
