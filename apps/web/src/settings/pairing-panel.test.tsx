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
  type ServerRegistrationId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import {
  createFakePairingOperations,
  type FakePairingOperations,
} from './fake-pairing-operations.js';
import { discoveredCandidates } from './pairing-form.js';
import type { PairingOutcome } from './pairing-operations.js';
import { PairingPanel } from './pairing-panel.js';

/**
 * The one pairing panel, on its own: what it sends, what it refuses before
 * sending anything, and what it says back.
 *
 * It is tested here rather than through the settings screen because the screen
 * is no longer the only place it is drawn -- the first-run wizard mounts the
 * same component -- and a test that went through one of them would be proving
 * a screen's wiring rather than the panel's behaviour. The candidates come out
 * of a captured `machine-state`, run through the same reader the app uses, so
 * the list drawn here is the list a real hub produces.
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

describe('the pairing panel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let paired: ServerRegistrationId[];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    paired = [];
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  /**
   * `announces` is whether a caller passed `onPaired`, which is the one thing
   * the two mounts of this panel differ by: settings has nowhere to send
   * anybody and the wizard has a next step.
   */
  async function mount(answer: PairingOutcome, announces = true): Promise<FakePairingOperations> {
    const pairing = createFakePairingOperations({ answer });
    // Spread rather than `onPaired={... : undefined}`: an optional property is
    // absent or a function here, and this app's TypeScript says so.
    const announcement = announces
      ? {
          onPaired: (registrationId: ServerRegistrationId): void => {
            paired.push(registrationId);
          },
        }
      : {};
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <PairingPanel pairing={pairing} candidates={CANDIDATES} scheme="dark" {...announcement} />
        </MantineProvider>,
      );
    });
    return pairing;
  }

  function field(label: string): HTMLInputElement {
    const input = [...container.querySelectorAll('label')]
      .find((element) => element.textContent === label)
      ?.closest('.mantine-InputWrapper-root')
      ?.querySelector<HTMLInputElement>('input');
    if (input === undefined || input === null) throw new Error(`no ${label} field`);
    return input;
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text,
    );
    if (found === undefined) throw new Error(`no ${text} button`);
    return found;
  }

  /** The error line Mantine draws under a field that said no. */
  function fieldErrors(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[class*="InputWrapper-error"]')];
  }

  function candidateRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-candidate]')];
  }

  async function submit(form: { name: string; address: string; token: string }): Promise<void> {
    await act(() => {
      typeInto(field('Name'), form.name);
      typeInto(field('Address'), form.address);
      typeInto(field('Server token'), form.token);
    });
    await act(() => {
      button('Pair server').click();
    });
    await act(settle);
  }

  it('sends the parsed request once and hands back the registration the hub named', async () => {
    const pairing = await mount(YES);

    await submit({
      name: '  gpu-box-01  ',
      address: ' wss://gpu-box-01.example:8443 ',
      token: ' printed-nowhere ',
    });

    // The request, not "a request": trimmed by the parser, with the address
    // carrying the protocol's brand, because nothing may reach `pairServer`
    // with an address that has not been through `serverAddressSchema`.
    expect(pairing.requests).toEqual([
      {
        label: 'gpu-box-01',
        address: serverAddressSchema.parse('wss://gpu-box-01.example:8443'),
        token: 'printed-nowhere',
      },
    ]);
    expect(paired).toEqual([PAIRED]);
  });

  it('tells a caller with nowhere to send anybody where the row will appear', async () => {
    await mount(YES, false);

    await submit({ name: 'gpu-box-01', address: 'wss://gpu-box-01.example:8443', token: 't' });

    expect(container.textContent).toContain(
      'Pairing recorded. The hub dials it from here; its row appears below.',
    );
  });

  it('says nothing of a row below when the caller draws what happens next', async () => {
    // "Below" is the settings list. The wizard mounts this same panel with no
    // list under it and its own line to draw, so the panel's version of the
    // news would be both a second sentence and a false one.
    await mount(YES);

    await submit({ name: 'gpu-box-01', address: 'wss://gpu-box-01.example:8443', token: 't' });

    expect(container.textContent).not.toContain('Pairing recorded');
    expect(paired).toEqual([PAIRED]);
  });

  it('draws the hub refusal in its own words, and announces nothing', async () => {
    // The refusal a real hub answers a mistyped address with.
    const reason = 'expected a wss:// address, not the scheme "ws:"';
    await mount({ ok: false, reason });

    await submit({ name: 'gpu-box-01', address: 'wss://gpu-box-01.example:8443', token: 't' });

    expect(container.textContent).toContain(reason);
    // A refusal is not a pairing: whoever is waiting to be told a server was
    // added must not be told one was.
    expect(paired).toEqual([]);
  });

  it('refuses an empty form in its own fields, and sends nothing', async () => {
    const pairing = await mount(YES);

    await act(() => {
      button('Pair server').click();
    });
    await act(settle);

    // Three fields said no, each under its own label. Counted through the
    // wrapper's error element rather than the text, so a form that reported
    // one problem three times could not pass.
    expect(fieldErrors().length).toBe(3);
    expect(container.textContent).toContain('expected a name for this server');
    expect(container.textContent).toContain("expected the token in that server's identity file");
    expect(pairing.requests).toEqual([]);
  });

  it('fills the address from a candidate and stops there', async () => {
    await mount(YES);

    const [usable] = candidateRows();
    expect(usable?.textContent).toContain('server-mbp');
    await act(() => {
      usable?.querySelector('button')?.click();
    });

    expect(field('Address').value).toBe('wss://192.168.1.24:8443');
    // Being heard is not being trusted: the token is still typed, and so is
    // the name -- what the beacon calls itself is a hint on the list, not a
    // value typed into somebody's form on their behalf.
    expect(field('Name').value).toBe('');
    expect(field('Server token').value).toBe('');
  });

  it('draws a machine this build cannot speak to, and refuses to fill from it', async () => {
    await mount(YES);

    const mismatched = candidateRows()[1];
    expect(mismatched?.textContent).toContain('server-old-build');
    expect(mismatched?.textContent).toContain('this hub speaks server protocol');
    expect(mismatched?.querySelector('button')?.disabled).toBe(true);
  });
});
