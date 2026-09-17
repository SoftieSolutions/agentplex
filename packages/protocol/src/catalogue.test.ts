import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_SEARCH_MAX_CHARS,
  catalogueFilterSchema,
  catalogueItemSchema,
  catalogueQuerySchema,
} from './catalogue.js';
import { parseClientFrame, parseHubFrame } from './client.js';
import {
  nodeIdSchema,
  nodeKindSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';

/**
 * The catalogue query's shapes.
 *
 * What is worth asserting here is not that zod parses objects. It is the three
 * decisions the shape encodes: every parameter of the query is a closed set or
 * a bound, so nothing on this frame is a column name or an ordering clause a
 * client invented; an item carries its session row whole, so the client joins
 * nothing; and a cursor is a string the client may only hand back.
 */

const QUERY = {
  view: 'list',
  groupBy: 'server',
  sort: { key: 'name', direction: 'asc' },
  filter: {},
  cursor: null,
  limit: 50,
};

const ITEM = {
  id: nodeIdSchema.parse('node-1'),
  parentId: null,
  kind: nodeKindSchema.parse('session'),
  position: 0,
  name: 'fix-auth-refresh',
  named: false,
  anchor: {
    storeId: storeIdSchema.parse('store-work'),
    sessionId: sessionIdSchema.parse('session-1'),
  },
  depth: 0,
  displayName: 'fix-auth-refresh',
  nameSource: 'node',
  session: null,
  directory: null,
  server: null,
  group: null,
  matched: null,
};

describe('a catalogue query', () => {
  it('accepts the whole of what a client may ask for', () => {
    expect(catalogueQuerySchema.parse(QUERY)).toMatchObject({ view: 'list', limit: 50 });
  });

  /**
   * The rule this frame exists under. A query that could carry a column name,
   * an expression or an ordering clause would be the generic surface the rule
   * about argv and env vars keeps shut, pointed at the database instead of at a
   * spawn -- so every parameter is a closed set, and a fourth sort key is a
   * protocol change rather than a string somebody sends.
   */
  it('refuses a sort key, a view or a grouping it does not name', () => {
    expect(catalogueQuerySchema.safeParse({ ...QUERY, view: 'gallery' }).success).toBe(false);
    expect(catalogueQuerySchema.safeParse({ ...QUERY, groupBy: 'provider' }).success).toBe(false);
    expect(
      catalogueQuerySchema.safeParse({ ...QUERY, sort: { key: 'cost', direction: 'asc' } }).success,
    ).toBe(false);
    expect(
      catalogueQuerySchema.safeParse({ ...QUERY, sort: { key: 'name', direction: 'sideways' } })
        .success,
    ).toBe(false);
  });

  it('refuses a limit that is not a positive whole number of items', () => {
    expect(catalogueQuerySchema.safeParse({ ...QUERY, limit: 0 }).success).toBe(false);
    expect(catalogueQuerySchema.safeParse({ ...QUERY, limit: -1 }).success).toBe(false);
    expect(catalogueQuerySchema.safeParse({ ...QUERY, limit: 1.5 }).success).toBe(false);
  });

  /**
   * The one schema here where optional is right rather than the nullable this
   * protocol otherwise prefers: an absent constraint and a constraint on
   * nothing are the same thing, which is no constraint.
   */
  it('takes an empty filter as filtering by nothing', () => {
    expect(catalogueFilterSchema.parse({})).toEqual({});
  });

  it('refuses a provider or a status it does not know', () => {
    expect(catalogueFilterSchema.safeParse({ provider: 'claude' }).success).toBe(true);
    expect(catalogueFilterSchema.safeParse({ provider: 'gpt' }).success).toBe(false);
    expect(catalogueFilterSchema.safeParse({ status: 'awaiting-permission' }).success).toBe(true);
    expect(catalogueFilterSchema.safeParse({ status: 'busy' }).success).toBe(false);
  });

  it('bounds a search, so a bug cannot fill one without anything objecting', () => {
    expect(
      catalogueFilterSchema.safeParse({ search: 'x'.repeat(CATALOGUE_SEARCH_MAX_CHARS) }).success,
    ).toBe(true);
    expect(
      catalogueFilterSchema.safeParse({ search: 'x'.repeat(CATALOGUE_SEARCH_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
  });
});

describe('a catalogue item', () => {
  it('accepts a session node with no reading behind it', () => {
    expect(catalogueItemSchema.parse(ITEM)).toEqual(ITEM);
  });

  /**
   * The whole reading, exactly as the machine state carries it. A page and a
   * state that disagreed about one session would have nothing able to say which
   * was right, and the cheapest way to make that impossible is one shape.
   */
  it('carries the fleet state row whole, rather than fields picked off it', () => {
    const session = {
      descriptor: {
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
        provider: 'claude',
        status: 'working',
        updatedAt: 1_756_000_000_000,
        cwd: '/Users/robert/code/agentplex',
        branch: 'fix/auth-refresh',
        title: 'fix-auth-refresh',
        uncommitted: null,
      },
      source: serverRegistrationIdSchema.parse('registration-mbp'),
      reportedBy: [serverRegistrationIdSchema.parse('registration-mbp')],
      reportedAt: 1_756_000_000_000,
      reachable: true,
      holder: null,
      acknowledgedAt: null,
      mutedAt: null,
    };

    expect(catalogueItemSchema.parse({ ...ITEM, session })).toMatchObject({ session });
  });

  it('refuses a kind of name source it does not name', () => {
    expect(catalogueItemSchema.safeParse({ ...ITEM, nameSource: 'guessed' }).success).toBe(false);
  });

  it('refuses a match field it does not name', () => {
    expect(catalogueItemSchema.safeParse({ ...ITEM, matched: 'branch' }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...ITEM, matched: 'cwd' }).success).toBe(true);
  });

  /**
   * A kind is an open string here for the reason it is one on a layout node: a
   * new kind is a row in the hub's database, and an enum would make it a
   * protocol change and a client release.
   */
  it('accepts a kind this build has never heard of', () => {
    expect(
      catalogueItemSchema.safeParse({ ...ITEM, kind: nodeKindSchema.parse('saved-search') })
        .success,
    ).toBe(true);
  });
});

describe('the catalogue frames', () => {
  it('accepts the query as a client frame', () => {
    expect(parseClientFrame({ type: 'catalogue-query', id: 1, ...QUERY }).ok).toBe(true);
  });

  it('accepts a cursor the hub handed out, and refuses an empty one', () => {
    expect(
      parseClientFrame({ type: 'catalogue-query', id: 1, ...QUERY, cursor: 'eyJmIjoxfQ' }).ok,
    ).toBe(true);
    expect(parseClientFrame({ type: 'catalogue-query', id: 1, ...QUERY, cursor: '' }).ok).toBe(
      false,
    );
  });

  it('accepts the page as a hub frame, and refuses a total that is not a count', () => {
    expect(
      parseHubFrame({
        type: 'catalogue-page',
        replyTo: 1,
        items: [ITEM],
        nextCursor: null,
        total: 1,
        version: 3,
      }).ok,
    ).toBe(true);
    expect(
      parseHubFrame({
        type: 'catalogue-page',
        replyTo: 1,
        items: [],
        nextCursor: null,
        total: -1,
        version: 3,
      }).ok,
    ).toBe(false);
  });
});
