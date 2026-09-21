// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import {
  createSessionFiltersStore,
  type SessionFiltersStore,
} from '../sessions/session-filters-store.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SidebarSessions } from './sidebar-sessions.js';

/**
 * The sidebar's rows, on a captured fleet that carries both cases: the
 * universe store's sessions sit in a project the hub's tree named, and the
 * agentplex store's sit in none.
 *
 * What is asserted is the second line and only the second line. The order, the
 * narrowing and the names are `session-list-model`'s, pinned by its own suite;
 * what belongs here is that this row reads the place off the item instead of
 * assembling one, and that a session in no project still gets a line a person
 * can read rather than a dot with a blank in front of it.
 *
 * And, since AGX-255, that these rows answer the filter row now drawn above
 * them. That row's badge counts what the narrowings hid, so an index under it
 * still listing them would be a badge counting rows a person can see.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);

/** The moment every age on these renders is measured against. */
const NOW = 1_756_000_000_000;

describe('a sidebar session row', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let filters: SessionFiltersStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    filters = createSessionFiltersStore();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <SidebarSessions
            state={populated}
            filters={filters}
            machine={null}
            scheme="dark"
            now={() => NOW}
          />
        </MantineProvider>,
      );
    });
  }

  /** The narrowings the row above writes, written the way that row writes them. */
  function narrow(changes: Parameters<SessionFiltersStore['set']>[0]): void {
    act(() => {
      filters.set(changes);
    });
  }

  function names(): string[] {
    return rows().map((row) => (row.getAttribute('aria-label') ?? '').replace('open ', ''));
  }

  function words(): string {
    return container.textContent ?? '';
  }

  function rows(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="open "]')];
  }

  /** A row's second line: the last thing the row draws, under the name. */
  function placeOf(row: HTMLAnchorElement): string {
    const place = row.lastElementChild;
    if (place === null) throw new Error(`${row.ariaLabel ?? 'a row'} drew no second line`);
    return place.textContent ?? '';
  }

  function placeLine(name: string): string {
    const row = rows().find((candidate) => candidate.getAttribute('aria-label') === `open ${name}`);
    if (row === undefined) throw new Error(`the fixture drew no row for ${name}`);
    return placeOf(row);
  }

  it('reads the project the row carries, beside the machine', () => {
    draw();
    expect(placeLine('docs-sweep')).toBe('universe · gpu-box-01');
  });

  it('keeps the store on a session the tree places in no project', () => {
    draw();
    expect(placeLine('fix-auth-refresh')).toBe('store-agentplex · mbp-robert');
  });

  it('draws no separator with nothing in front of it', () => {
    draw();
    expect(rows()).not.toHaveLength(0);
    for (const row of rows()) {
      expect(placeOf(row)).not.toMatch(/^\s*·/);
    }
  });

  it('narrows to what was typed into the row above it', () => {
    draw();
    expect(names()).toContain('docs-sweep');

    narrow({ search: 'bench' });

    expect(names()).toEqual(['bench-tokenizer']);
  });

  it('answers the popover as well as the box, because it is one set of choices', () => {
    draw();
    expect(names().length).toBeGreaterThan(1);

    narrow({ chip: 'needs-you' });

    // The two the fixture has waiting on somebody, and nothing else: a badge
    // reading 1 over an index still listing all six would be counting rows
    // that are on the screen under it.
    expect(names()).toEqual(['migrate-db-v9', 'docs-sweep']);
  });

  it('says the narrowing emptied it rather than blaming the fleet', () => {
    draw();

    narrow({ search: 'nothing is called this' });

    expect(names()).toEqual([]);
    expect(words()).toContain('no session here matches the narrowing');
    expect(words()).not.toContain('no sessions in any store yet');
  });
});
