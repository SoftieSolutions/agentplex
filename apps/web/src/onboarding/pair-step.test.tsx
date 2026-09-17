// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  serverAddressSchema,
  serverRegistrationIdSchema,
  type MachineState,
} from '@agentplex/protocol';
import {
  createFakePairingOperations,
  type FakePairingOperations,
} from '../settings/fake-pairing-operations.js';
import { discoveredCandidates } from '../settings/pairing-form.js';
import type { PairingOutcome } from '../settings/pairing-operations.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { PairStep } from './pair-step.js';

/**
 * The wizard's live step: the question before the form, and what follows a
 * pairing.
 *
 * The question is the point of this file. A first-run reader is one of two
 * people -- somebody who already has a server running and somebody who has
 * never installed one -- and a form drawn before that is known asks the second
 * of them for an address that does not exist yet. So nothing is drawn until
 * the choice is made, and this test holds that: no form, no token field, and
 * nothing sendable.
 *
 * The pairing itself is not re-tested here; it is `pairing-panel.test.tsx`,
 * and the panel is the same component in both places. What is tested is what
 * the step wraps around it -- which choice draws it, what it is given, and the
 * fact that a recorded pairing replaces the form with a way out rather than
 * leaving a filled-in form sitting there inviting a second one.
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

/** Mantine's inputs observe their own box; jsdom has no layout and no observer. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets the fake's already-resolved answer reach the panel's `then`. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * React tracks an input's value itself, so assigning `input.value` and firing
 * an event is a change React has already decided did not happen. The setter
 * off the prototype is the one the tracker does not intercept.
 */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on HTMLInputElement');
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') throw new Error('not machine-state');
  return parsed.value.state;
}

const PAIRED = serverRegistrationIdSchema.parse('registration-1');
const YES: PairingOutcome = { ok: true, registrationId: PAIRED };

/** The two machines the captured state announces, read the way the app reads them. */
const CANDIDATES = discoveredCandidates(stateFrom(hubFrames.machineStateDiscovered));

describe('the wizard pairing step', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let done: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    done = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function mount(answer: PairingOutcome = YES): Promise<FakePairingOperations> {
    const pairing = createFakePairingOperations({ answer });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <PairStep
            pairing={pairing}
            candidates={CANDIDATES}
            scheme="dark"
            onDone={() => {
              done += 1;
            }}
          />
        </MantineProvider>,
      );
    });
    return pairing;
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text,
    );
    if (found === undefined) throw new Error(`no ${text} button`);
    return found;
  }

  function hasButton(text: string): boolean {
    return [...container.querySelectorAll('button')].some(
      (element) => element.textContent === text,
    );
  }

  function field(label: string): HTMLInputElement {
    const input = [...container.querySelectorAll('label')]
      .find((element) => element.textContent === label)
      ?.closest('.mantine-InputWrapper-root')
      ?.querySelector<HTMLInputElement>('input');
    if (input === undefined || input === null) throw new Error(`no ${label} field`);
    return input;
  }

  async function click(text: string): Promise<void> {
    await act(() => {
      button(text).click();
    });
  }

  async function pair(): Promise<void> {
    await click('I already run a server');
    await act(() => {
      typeInto(field('Name'), 'gpu-box-01');
      typeInto(field('Address'), 'wss://gpu-box-01.example:8443');
      typeInto(field('Server token'), 'printed-nowhere');
    });
    await click('Pair server');
    await act(settle);
  }

  it('asks which reader this is before it asks for anything', async () => {
    await mount();

    expect(hasButton('I already run a server')).toBe(true);
    expect(hasButton('I need to run one')).toBe(true);
    // An address and a token are what somebody who has never installed a
    // server does not have, so the form is not drawn at them.
    expect(hasButton('Pair server')).toBe(false);
    expect(container.querySelector('input')).toBe(null);
  });

  it('draws the pairing form, machines and all, for a reader who has a server', async () => {
    await mount();

    await click('I already run a server');

    expect(field('Address').value).toBe('');
    expect(hasButton('Pair server')).toBe(true);
    // The candidates reach the panel: the wizard passes what the hub heard on
    // the network, and a step that dropped them would make the first machine
    // somebody pairs the one they had to type an address for.
    expect(container.querySelector('[data-candidate]')?.textContent).toContain('server-mbp');
  });

  it('sends the pairing and then says what happens next, with a way out', async () => {
    const pairing = await mount();

    await pair();

    expect(pairing.requests).toEqual([
      {
        label: 'gpu-box-01',
        address: serverAddressSchema.parse('wss://gpu-box-01.example:8443'),
        token: 'printed-nowhere',
      },
    ]);
    expect(container.textContent).toContain('Pairing recorded; the hub dials it from here');
    // The form goes: a second pairing of the same machine is not what the next
    // click should be, and a filled form left standing invites one.
    expect(hasButton('Pair server')).toBe(false);

    await click('Done');

    expect(done).toBe(1);
  });

  it('says it once: the panel does not point at a row list this screen has not got', async () => {
    await mount();

    await pair();

    // The panel's own success line ends "its row appears below", which is true
    // in settings and false here -- the wizard is the whole route and there is
    // no list under it.
    expect(container.textContent).not.toContain('its row appears below');
  });

  it('points a reader with no server at the install, and asks them for nothing', async () => {
    await mount();

    await click('I need to run one');

    expect(container.textContent).toContain('apps/cli/README.md');
    expect(hasButton('Pair server')).toBe(false);
  });

  it('never says a server dials the hub, because it does not', async () => {
    await mount();

    await click('I need to run one');
    const installing = container.textContent ?? '';
    await click('I already run a server');
    const pairing = container.textContent ?? '';
    await pair();
    const recorded = container.textContent ?? '';

    // The hub dials the server. A sentence the other way round on this step is
    // an instruction to open a port on the machine that needs none.
    const backwards = /server[^.]*\b(dials?|connects? to|points? at|reaches?)\b[^.]*hub/i;
    expect(installing).not.toMatch(backwards);
    expect(pairing).not.toMatch(backwards);
    expect(recorded).not.toMatch(backwards);
  });
});
