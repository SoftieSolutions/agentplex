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
import { serverRows, type ServerRowView } from '../settings/server-rows.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { installCommand } from './install-command.js';
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

/** The machine `machineStateWithServer` carries, which never answered. */
const UNREACHED = serverRegistrationIdSchema.parse('pairing-1');
const REACHED_NOBODY: PairingOutcome = { ok: true, registrationId: UNREACHED };

/** The rows a captured frame projects into, the way the screen above gets them. */
function rowsFrom(text: string): readonly ServerRowView[] {
  return serverRows(stateFrom(text));
}

/**
 * The hub stamped the captured `connected` row at this instant, so the age the
 * card draws is a function of the `now` this file injects rather than of the
 * day the suite happens to run.
 */
const CONNECTED_SINCE = 1_756_000_000_000;
const FOUR_MINUTES_LATER = CONNECTED_SINCE + 4 * 60_000;

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
    root = createRoot(container);
    await render(pairing, []);
    return pairing;
  }

  /**
   * Draws the step over one set of rows. Calling it again is how this file
   * delivers a machine-state broadcast: the rows are a prop from the screen
   * that holds the store's snapshot, so a new state arriving is a re-render
   * with new rows, and the step is supposed to follow it without being told
   * anything else.
   */
  async function render(
    pairing: FakePairingOperations,
    rows: readonly ServerRowView[],
  ): Promise<void> {
    await act(async () => {
      root?.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <PairStep
            pairing={pairing}
            candidates={CANDIDATES}
            rows={rows}
            scheme="dark"
            now={FOUR_MINUTES_LATER}
            onDone={() => {
              done += 1;
            }}
          />
        </MantineProvider>,
      );
    });
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

  /**
   * What the step says, with Mantine's injected stylesheet out of it: its
   * `<style>` text is part of `container.textContent`, and a copy assertion
   * that reads it is an assertion about the component library.
   */
  function copy(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
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
    // The form goes: a second pairing of the same machine is not what the next
    // click should be, and a filled form left standing invites one.
    expect(hasButton('Pair server')).toBe(false);

    await click('Done');

    expect(done).toBe(1);
  });

  it('draws the machine once the hub publishes the row that names it', async () => {
    const pairing = await mount();

    await pair();
    await render(pairing, rowsFrom(hubFrames.machineStateJustPaired));

    // The card's own states are pinned in `machine-card.test.tsx`. What this
    // holds is the wiring: the id the panel handed back picks this row out of
    // the broadcast, and the rows reach the card without a poll or an effect
    // between them.
    const said = copy();
    expect(said).toContain('mbp-robert connected');
    expect(said).toContain('wss://mbp-robert.example:8443');
    expect(said).toContain('connected 4m');
    expect(said).toContain('store-agentplex');
    expect(said).toContain('claude 9.9.9');
    expect(said).not.toContain('Pairing recorded');
  });

  it('stops on the machine that never answered, and still lets the reader out', async () => {
    const pairing = await mount(REACHED_NOBODY);

    await pair();
    await render(pairing, rowsFrom(hubFrames.machineStateWithServer));

    const said = copy();
    expect(said).toMatch(/unreachable/i);
    expect(said).toContain('connection refused');
    expect(said).toContain('Settings can unpair it');
    // No spinner: the dial failed, so there is nothing in flight to spin at.
    expect(container.querySelector('[class*="Loader"]')).toBe(null);

    // And the way out is still there. The reader whose machine never answers
    // is the one a wizard most easily traps.
    await click('Done');
    expect(done).toBe(1);
  });

  it('says only that the pairing is recorded until a row names it', async () => {
    await mount();

    await pair();

    // The `server-paired` reply and the state that includes the row are two
    // broadcasts. Between them the only true sentence is that the hub wrote
    // the pairing down.
    expect(copy()).toContain('Pairing recorded; the hub dials it from here');
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

  it('gives a reader with no server the command, and asks them for nothing', async () => {
    await mount();

    await click('I need to run one');

    // The enroll panel, whose own tests pin what it draws. What this holds is
    // that this branch mounts it at all, and that it is still not a form: an
    // address and a token are the two values this reader has not got yet.
    expect(container.textContent).toContain(installCommand('linux'));
    expect(hasButton('Pair server')).toBe(false);
    expect(container.querySelector('input')).toBe(null);
  });

  it('takes the reader back to the form once they have been to that machine', async () => {
    await mount();

    await click('I need to run one');
    await click('I have the token, pair it');

    // The two answers are a round trip. A reader who followed the install and
    // came back with a token would otherwise have to work out that the way on
    // is the button they already said no to.
    expect(hasButton('Pair server')).toBe(true);
    expect(field('Address').value).toBe('');
  });

  it('puts the token where setup puts it, and never says anything printed it', async () => {
    await mount();

    // The two states this step words by itself, with the panel out of the
    // way: what the panel says is pinned in `pairing-panel.test.tsx`, and
    // this is the copy that has to agree with it.
    const question = copy();
    await click('I need to run one');
    const installing = copy();

    // Setup writes the token into the server's identity file and shows it
    // nowhere. A step that promises a printed token sends the reader to
    // search a scrollback that never carried one.
    expect(installing).toContain('~/.agentplex/server.json');
    expect(question).toMatch(/identity file/i);
    expect(question).not.toMatch(/print/i);
    expect(installing).not.toMatch(/print/i);
  });

  it('never says a server dials the hub, because it does not', async () => {
    const pairing = await mount();

    await click('I need to run one');
    const installing = container.textContent ?? '';
    await click('I already run a server');
    const paired = container.textContent ?? '';
    await pair();
    const recorded = container.textContent ?? '';
    await render(pairing, rowsFrom(hubFrames.machineStateJustPaired));
    const online = container.textContent ?? '';

    // The hub dials the server. A sentence the other way round on this step is
    // an instruction to open a port on the machine that needs none.
    const backwards = /server[^.]*\b(dials?|connects? to|points? at|reaches?)\b[^.]*hub/i;
    expect(installing).not.toMatch(backwards);
    expect(paired).not.toMatch(backwards);
    expect(recorded).not.toMatch(backwards);
    expect(online).not.toMatch(backwards);
  });
});
