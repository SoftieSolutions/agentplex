// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { serverRows, type ServerRowView } from '../settings/server-rows.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForTone } from '../ui/tokens.js';
import { MachineCard } from './machine-card.js';
import { pairProgress, type PairProgress } from './pair-progress-model.js';

/**
 * What the wizard's last screen draws about the one machine somebody paired.
 *
 * Every progress here comes out of `pairProgress` over rows projected from a
 * captured frame, rather than being written as an object literal: this file is
 * meant to prove that what the hub published reaches the screen, and a
 * hand-built progress would only prove that the card can draw what its author
 * imagined. The states the card has to survive are the unhappy ones, so they
 * are the ones with the most assertions -- a machine that never answers is the
 * whole reason this card exists instead of a tick.
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

/** The rows a captured frame projects into, the way every screen gets them. */
function rowsFrom(text: string): readonly ServerRowView[] {
  return serverRows(stateFrom(text));
}

function onlyRow(rows: readonly ServerRowView[]): ServerRowView {
  const row = rows[0];
  if (row === undefined) throw new Error('the fixture projected no rows');
  return row;
}

/** The progress a captured frame reads as, for the one registration it names. */
function progressFrom(text: string): PairProgress {
  const rows = rowsFrom(text);
  return pairProgress(rows, onlyRow(rows).registrationId);
}

/**
 * The captured `connected` row was stamped at this instant by the hub's clock,
 * so the age the card draws is a function of the `now` a test hands it.
 */
const CONNECTED_SINCE = 1_756_000_000_000;
const FOUR_MINUTES_LATER = CONNECTED_SINCE + 4 * 60_000;

/**
 * A hue as jsdom reports it once drawn: an inline hex comes back as
 * `rgb(...)`, so the expected colour goes through the same normalisation
 * rather than through conversion arithmetic written in a test.
 */
function asDrawn(color: string): string {
  const probe = document.createElement('span');
  probe.style.background = color;
  return probe.style.background;
}

describe('the wizard machine card', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function draw(progress: PairProgress, now = FOUR_MINUTES_LATER): Promise<void> {
    await act(async () => {
      root ??= createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <MachineCard progress={progress} scheme="dark" now={now} />
        </MantineProvider>,
      );
    });
  }

  /**
   * What the card says, with Mantine's injected stylesheet out of it: its
   * `<style>` text is part of `container.textContent`, and a copy assertion
   * that reads it is an assertion about the component library.
   */
  function copy(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
  }

  /** The card's own tone dot: the round span above any provider line. */
  function headlineDotColor(): string {
    const dot = [...container.querySelectorAll('span')].find(
      (span) => span.style.borderRadius === '50%',
    );
    if (dot === undefined) throw new Error('the card drew no tone dot');
    return dot.style.background;
  }

  it('says only that the pairing is on file while no row names it', async () => {
    await draw({ kind: 'recorded' });

    // The `server-paired` reply carries an id; the state that includes the row
    // is a separate broadcast. Between the two, a machine name or an address
    // on screen would be the wizard drawing something the hub has not said.
    expect(copy()).toContain('Pairing recorded');
    expect(copy()).not.toMatch(/connected/i);
  });

  it('draws the machine the hub reached, and how long it has been reached', async () => {
    await draw(progressFrom(hubFrames.machineStateJustPaired));

    const said = copy();
    expect(said).toContain('mbp-robert connected');
    expect(said).toContain('wss://mbp-robert.example:8443');
    // The age is computed from the injected `now` against the instant the hub
    // stamped, so this reads `connected 4m` and not whatever the wall clock
    // makes of a fixture captured in 2025.
    expect(said).toContain('connected 4m');
  });

  it('names the stores and what that machine can actually start', async () => {
    await draw(progressFrom(hubFrames.machineStateJustPaired));

    const said = copy();
    expect(said).toContain('store-agentplex');
    // The failure this line exists for is invisible everywhere else: a machine
    // whose `claude` is missing is connected, lists its stores, and refuses
    // every start. Naming the version says which binary is going to run.
    expect(said).toContain('claude 9.9.9');
  });

  it('claims no operating system and no build number, because no frame carries one', async () => {
    await draw(progressFrom(hubFrames.machineStateJustPaired));

    // The mockup this card comes from drew `macOS 15.6 · daemon 2.0.3` here.
    // Neither fact is on any frame the hub sends, and a first-run reader has
    // no way to check either, which is the worst place in the product to
    // invent one.
    const said = copy();
    expect(said).not.toMatch(/macOS|Linux|Windows/i);
    expect(said).not.toMatch(/daemon/i);
  });

  it('draws a draining machine in its own tone, not in a healthy one', async () => {
    await draw(progressFrom(hubFrames.machineStateDraining));

    // The socket is up and the hub is being answered, so this is the online
    // card -- but the tone is the row's rather than a constant in the markup.
    // A machine with fifteen seconds left on it used to be drawn exactly like
    // one that had just come up.
    expect(copy()).toContain('mbp-robert shutting down, 1 session finishing');
    expect(headlineDotColor()).toBe(asDrawn(colorForTone('needs-you', 'dark')));
    expect(headlineDotColor()).not.toBe(asDrawn(colorForTone('running', 'dark')));
  });

  it('says a machine shut down rather than that nobody could reach it', async () => {
    // The drain warned this was coming and the row carries the word. A card
    // that headlines every stale row "unreachable" throws that warning away
    // and sends somebody to debug a machine that did what it said it would.
    const captured = stateFrom(hubFrames.machineStateDraining);
    const row = captured.servers[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const rows = serverRows({
      ...captured,
      servers: [
        {
          ...row,
          phase: 'stale',
          staleReason: 'draining',
          connectedSince: null,
          staleSince: 1_756_000_015_000,
          problem:
            'the server said it was shutting down with 1 session finishing, and then closed the connection',
        },
      ],
    });

    await draw(pairProgress(rows, row.registrationId));

    const said = copy();
    expect(said).toContain('mbp-robert shut down');
    expect(said).not.toMatch(/unreachable/i);
  });

  it('shows a dial in progress without claiming it landed', async () => {
    // The captured row re-read through the parser with only the phase fields
    // varied: the hub publishes `connecting` at its own moment, and the
    // capture caught this machine at a later one.
    const captured = stateFrom(hubFrames.machineStateWithServer);
    const row = captured.servers[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const rows = serverRows({
      ...captured,
      servers: [{ ...row, phase: 'connecting', staleSince: null, staleReason: null }],
    });

    await draw(pairProgress(rows, row.registrationId));

    const said = copy();
    expect(said).toContain('gpu-box-01');
    expect(said).toMatch(/dialling/i);
    // The dial has not landed. Anything on this card reading as an arrival is
    // the wizard congratulating somebody on a machine nobody has reached.
    expect(said).not.toMatch(/\bconnected\b/i);
  });

  it('stops on an unreachable machine, in the hub words, with the way on', async () => {
    await draw(progressFrom(hubFrames.machineStateWithServer));

    const said = copy();
    expect(said).toContain('gpu-box-01');
    expect(said).toMatch(/unreachable/i);
    expect(said).toContain('connection refused');
    expect(said).toContain('Settings can unpair it');
  });

  it('spins at nobody: an unreachable machine is an ending, not a wait', async () => {
    await draw(progressFrom(hubFrames.machineStateWithServer));

    // A spinner over a dial that has already failed leaves a first-run reader
    // watching a screen that is never going to change. The row stopped, so
    // the card stops with it.
    expect(container.querySelector('[role="progressbar"]')).toBe(null);
    expect(container.querySelector('[class*="Loader"]')).toBe(null);
  });

  it('never says a server dials the hub, in any state it can reach', async () => {
    // The hub dials the server. A sentence the other way round sends somebody
    // to open a port on the machine that needs none, which is both useless and
    // the one mistake here that costs them an exposed service.
    const backwards = /server[^.]*\b(dials?|connects? to|points? at|reaches?)\b[^.]*hub/i;
    const states: readonly PairProgress[] = [
      { kind: 'recorded' },
      progressFrom(hubFrames.machineStateJustPaired),
      progressFrom(hubFrames.machineStateWithServer),
    ];

    for (const progress of states) {
      await draw(progress);
      expect(copy()).not.toMatch(backwards);
    }
  });
});
