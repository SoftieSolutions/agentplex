// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { sessionHash } from '../terminal/session-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AdoptedSessions } from './adopted-sessions.js';
import { sessionsOnServer, type AdoptedSession } from './adopted-sessions-model.js';

/**
 * What the wizard shows under the connected card: the sessions the machine
 * somebody just paired was already holding.
 *
 * Every list here comes out of `sessionsOnServer` over a captured frame read
 * back through the parser, rather than out of object literals: this screen's
 * whole claim is that it reports what the hub published, and a hand-built list
 * would only prove the component can draw what its author imagined.
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
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.value.type !== 'machine-state') throw new Error(`captured a ${parsed.value.type}`);
  return parsed.value.state;
}

/**
 * A registration id as the capture spells it, found by the label a person
 * would read: ids are branded, and a literal cast would be this file asserting
 * what an id is rather than the frame saying it.
 */
function registrationFor(state: MachineState, label: string): ServerRegistrationId {
  const server = state.servers.find((view) => view.label === label);
  if (server === undefined) throw new Error(`the capture names no machine called ${label}`);
  return server.registrationId;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const found = sessionsOnServer(populated, registrationFor(populated, 'mbp-robert'));

/**
 * The instant the capture was reported at, so every age below is a function of
 * what the hub stamped rather than of the day the suite happens to run.
 */
const REPORTED_AT = 1_756_000_000_000;

describe('the sessions the wizard reports finding', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let left: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    left = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function draw(sessions: readonly AdoptedSession[]): Promise<void> {
    await act(async () => {
      root ??= createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <AdoptedSessions
            sessions={sessions}
            label="mbp-robert"
            scheme="dark"
            now={REPORTED_AT}
            onGoToSessions={() => {
              left += 1;
            }}
          />
        </MantineProvider>,
      );
    });
  }

  /**
   * What the list says, with Mantine's injected stylesheet out of it: its
   * `<style>` text is part of `container.textContent`, and a copy assertion
   * that reads it is an assertion about the component library.
   */
  function copy(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
  }

  function button(text: string): HTMLButtonElement {
    const match = [...container.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').includes(text),
    );
    if (match === undefined) throw new Error(`no button reads ${text}`);
    return match;
  }

  it('names every session it found, with the agent that wrote it', async () => {
    await draw(found);

    const said = copy();
    expect(said).toContain('fix-auth-refresh');
    expect(said).toContain('migrate-db-v9');
    expect(said).toContain('spike-wasm');
    // The provider is on the descriptor from day one, so a report of what was
    // found can always say which agent it belongs to.
    expect(said).toContain('claude');
    expect(said).toContain('codex');
  });

  it('draws the directory the session is working in', async () => {
    await draw(found);

    expect(copy()).toContain('/Users/robert/code/agentplex/db');
  });

  it('says what each session is doing and how long ago it said so', async () => {
    await draw(found);

    const said = copy();
    // `awaiting permission` is the session list's own vocabulary, and the age
    // is measured against the injected instant: this row was stamped three
    // minutes before the capture was reported.
    expect(said).toContain('awaiting permission · 3m');
    expect(said).toContain('working · 12m');
    expect(said).toContain('idle · 2h');
  });

  it('opens each session as a real link to its address', async () => {
    await draw(found);

    const link = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="open fix-auth-refresh"]',
    );
    expect(link).not.toBe(null);
    const row = found.find((session) => session.name === 'fix-auth-refresh');
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(link?.getAttribute('href')).toBe(sessionHash(row.ref));
    expect(link?.getAttribute('href')).toContain('session-fix-auth');
    // One per session, so every row is reachable by keyboard and openable in a
    // second tab, rather than the block being one click handler.
    expect(container.querySelectorAll('a[aria-label^="open "]')).toHaveLength(3);
  });

  it('says a directory was never recorded rather than filling one in', async () => {
    await draw(found);

    const said = copy();
    expect(said).toContain('working directory not recorded');
    // The row costs itself and not the list: the two sessions that did record
    // a directory still draw theirs.
    expect(said).toContain('/Users/robert/code/agentplex/db');
    expect(said).toContain('/Users/robert/code/agentplex');
    expect(container.querySelectorAll('a[aria-label^="open "]')).toHaveLength(3);
  });

  it('asks for nothing: there is no list to tick and no button to adopt', async () => {
    await draw(found);

    // The server watches its store and reports what is there, so by the time
    // this screen can name these sessions they are already the hub's. A
    // pre-checked list would ask permission for something that has happened.
    expect(container.querySelector('input[type="checkbox"]')).toBe(null);
    expect(copy()).not.toMatch(/adopt/i);
  });

  it('says the machine had none yet, by name, when it had none', async () => {
    await draw([]);

    const said = copy();
    expect(said).toContain('No agent sessions were found on mbp-robert yet');
    expect(said).toMatch(/session list/i);
    expect(container.querySelectorAll('a[aria-label^="open "]')).toHaveLength(0);
  });

  it('leaves the wizard when the reader takes the way out of the empty state', async () => {
    await draw([]);

    await act(async () => {
      button('Go to the session list').click();
    });

    expect(left).toBe(1);
  });
});
