import type { JSX } from 'react';
import { discoveredCandidates } from '../settings/pairing-form.js';
import { serverRows } from '../settings/server-rows.js';
import { pairingFor } from '../settings/settings-route.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import {
  Box,
  Button,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  Title,
  useComputedColorScheme,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { OnboardingDismissal } from './dismissal.js';
import { activeStep, type OnboardingStep } from './onboarding-model.js';
import { PairStep } from './pair-step.js';

/**
 * The first-run wizard: what this is, how far along getting it working the
 * reader is, and the way out.
 *
 * Two columns, from the approved mockup (turn 7f): a dark column carrying the
 * product's one sentence and the stepper, and a light-or-dark column carrying
 * whatever the live step needs. The split is what makes the wizard readable as
 * a wizard -- the left side never changes, so the right side is unambiguously
 * the part being worked on -- and it collapses to one column at phone widths
 * by dropping to a single grid column rather than by being a second layout.
 *
 * The left column is dark in both schemes, on the terminal well's precedent
 * (tokens.ts `terminalBackground`): it is a poster rather than a surface of
 * the app, and a poster that inverted itself at the light scheme would make
 * the first screen of the product the one thing that looks borrowed. It is
 * dark by asking `colorForRole` for the dark scheme's roles, so the hues stay
 * where every other hue in this app lives.
 *
 * Which step is live is read from the connection and never held here: the
 * store already knows whether the hub answered, so a copy of that in state
 * would be a second answer to a question that has one, kept in step by an
 * effect. `activeStep` turns the phase into the step, and this file draws it.
 *
 * What the copy may not say is as load-bearing as what it does. The hub dials
 * the server; the server dials nothing and listens for its hub. A sentence
 * here that read the other way round would send somebody to open a port on
 * the machine that does not need one, which is both useless and the one
 * mistake that costs them an exposed service.
 */

/**
 * The hero's scheme, fixed. Named rather than written at each call so the
 * reason above is attached to the decision and not repeated five times.
 */
const HERO: Scheme = 'dark';

export interface OnboardingScreenProps {
  readonly store: HubStore;
  /** Where "I have seen this" is written; injected, because a test has no browser storage worth trusting. */
  readonly dismissal: OnboardingDismissal;
}

export function OnboardingScreen({ store, dismissal }: OnboardingScreenProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  const scheme = useComputedColorScheme('dark');

  /**
   * Leaving the wizard: skipping it and finishing it are the same two writes,
   * so they are one function. In the body because it writes the browser's
   * address bar and the injected dismissal, both of which belong to this
   * screen rather than to a step.
   *
   * The dismissal's answer is deliberately not branched on: a browser that
   * refuses storage still gets to leave the screen it asked to leave, and it
   * says so by returning false rather than by refusing the click.
   */
  function leave(): void {
    dismissal.dismiss();
    // Out of the wizard's address and back to the app's default route. The
    // empty hash rather than a route constant: there is no wizard-shaped place
    // to go next, only the app.
    window.location.hash = '';
  }

  return (
    <SimpleGrid
      component="main"
      cols={{ base: 1, md: 2 }}
      spacing={0}
      style={{ minHeight: '100dvh', alignItems: 'stretch' }}
    >
      <WizardHero step={activeStep(snapshot.phase)} onSkip={leave} />
      <Box p={{ base: 'lg', md: 40 }} bg={colorForRole('background', scheme)}>
        {/* The same pairing the settings screen does, over the same operations
            this store already has: `pairingFor` is memoised per store, so the
            wizard and settings are two mounts of one panel rather than two
            pairing paths sharing a socket. */}
        <PairStep
          pairing={pairingFor(store)}
          candidates={discoveredCandidates(snapshot.machineState)}
          rows={serverRows(snapshot.machineState)}
          /* The state the rows were projected from, for the sessions the
             step reports under its card. One snapshot feeds both, so the
             machine and its holdings are always the same broadcast. */
          machineState={snapshot.machineState}
          scheme={scheme}
          onDone={leave}
        />
      </Box>
    </SimpleGrid>
  );
}

interface WizardHeroProps {
  readonly step: OnboardingStep;
  readonly onSkip: () => void;
}

/**
 * The unchanging column: the mark, the sentence, the two steps, and the exit.
 *
 * The stepper is a progress report and not a navigation bar, so it is given no
 * `onStepClick`: Mantine then draws the steps unclickable and out of the tab
 * order, which is the truth -- there is nothing to select, because which step
 * is live is a fact about the connection rather than a choice.
 */
function WizardHero({ step, onSkip }: WizardHeroProps): JSX.Element {
  return (
    <Stack
      h="100%"
      p={{ base: 'lg', md: 40 }}
      gap={40}
      justify="space-between"
      bg={colorForRole('background', HERO)}
      style={{ borderRight: `1px solid ${colorForRole('border', HERO)}` }}
    >
      <Stack gap={28}>
        {/* The installed app's own icon, so the wizard and the home screen
            shortcut are visibly the same thing. */}
        <img src="/icons/icon-192.png" alt="agentplex" width={40} height={40} />
        <Title order={1} fz={30} lh={1.15} maw={420} c={colorForRole('text', HERO)}>
          Every agent session, every machine, one place.
        </Title>
        <Stepper
          active={step === 'pair' ? 1 : 0}
          orientation="vertical"
          size="sm"
          role="group"
          aria-label="Setup steps"
          styles={{
            stepLabel: { color: colorForRole('text', HERO) },
            stepDescription: { color: colorForRole('textMuted', HERO) },
            verticalSeparator: { borderColor: colorForRole('border', HERO) },
          }}
        >
          <Stepper.Step label="Connect this hub" description="This browser talks to the hub." />
          <Stepper.Step label="Pair a server" description="The hub dials the machine." />
        </Stepper>
      </Stack>
      <Stack gap={10} align="flex-start">
        <Text fz={12} c={colorForRole('textMuted', HERO)}>
          You can enroll more machines later from Settings.
        </Text>
        <Button size="xs" variant="subtle" onClick={onSkip}>
          Skip for now
        </Button>
      </Stack>
    </Stack>
  );
}
