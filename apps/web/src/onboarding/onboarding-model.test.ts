import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { activeStep, onboardingVerdict } from './onboarding-model.js';

/**
 * Both states here are captured machine-state frames a real hub sent (see
 * hub-frames.fixture.ts): a hub that has never been paired with anything, and
 * the same hub once one pairing exists. The distinction the gate turns on is
 * the whole of what it can read, so it is read from real frames rather than
 * from a hand-written pair of objects that could not be wrong.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const unpaired = stateFrom(hubFrames.machineState);
const paired = stateFrom(hubFrames.machineStateWithServer);

describe('the verdict before anything is known', () => {
  it('waits while no machine state has arrived', () => {
    expect(onboardingVerdict({ machineState: null, dismissed: false, requested: false })).toBe(
      'wait',
    );
  });

  it('waits rather than hiding when dismissed and still unanswered', () => {
    expect(onboardingVerdict({ machineState: null, dismissed: true, requested: false })).toBe(
      'wait',
    );
  });
});

describe('the verdict once the hub has answered', () => {
  it('shows the wizard when the hub is paired with nothing', () => {
    expect(onboardingVerdict({ machineState: unpaired, dismissed: false, requested: false })).toBe(
      'show',
    );
  });

  it('hides the wizard as soon as one server is paired', () => {
    expect(onboardingVerdict({ machineState: paired, dismissed: false, requested: false })).toBe(
      'hide',
    );
  });

  it('hides the wizard once it has been dismissed, servers or none', () => {
    expect(onboardingVerdict({ machineState: unpaired, dismissed: true, requested: false })).toBe(
      'hide',
    );
    expect(onboardingVerdict({ machineState: paired, dismissed: true, requested: false })).toBe(
      'hide',
    );
  });
});

describe('the verdict when the address asked for it', () => {
  it('shows the wizard before any state has arrived', () => {
    expect(onboardingVerdict({ machineState: null, dismissed: false, requested: true })).toBe(
      'show',
    );
  });

  it('shows the wizard over a paired server', () => {
    expect(onboardingVerdict({ machineState: paired, dismissed: false, requested: true })).toBe(
      'show',
    );
  });

  it('shows the wizard over an earlier dismissal', () => {
    expect(onboardingVerdict({ machineState: paired, dismissed: true, requested: true })).toBe(
      'show',
    );
  });
});

describe('the active step', () => {
  it('is the pairing step only while the hub is connected', () => {
    expect(activeStep('connected')).toBe('pair');
  });

  it('is the connect step for every phase that is not a live connection', () => {
    expect(activeStep('idle')).toBe('connect');
    expect(activeStep('connecting')).toBe('connect');
    expect(activeStep('reconnecting')).toBe('connect');
    expect(activeStep('failed')).toBe('connect');
  });
});
