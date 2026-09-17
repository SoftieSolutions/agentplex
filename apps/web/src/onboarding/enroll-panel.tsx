import { useState, type JSX } from 'react';
import { browserClipboard, clipboardProblem, type Clipboard } from '../terminal/clipboard.js';
import { Button, Code, Group, Stack, Tabs, Text, Title } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { installCommand, targetNotes, type InstallTarget } from './install-command.js';

/**
 * What the wizard shows a reader who has no server yet: the one command for
 * the machine in front of them, and the one thing that command leaves behind
 * that they have to come back with.
 *
 * The shape is the approved mockup's right column (turn 7f) -- heading, one
 * sentence, a row of tabs, a command box with a prompt and a Copy button, a
 * status line under it -- with two of its pieces gone, because the mock was
 * drawn against a product that worked the other way round.
 *
 * The first is the token. The mock minted one into the one-liner and put a
 * countdown under it. Nothing here mints anything: the server mints its own
 * identity on the machine it installs, into a file the reader reads, so there
 * is no secret on this screen to leak into a shell history or a screenshot.
 * `install-command.ts` is where that is decided and where a test holds it.
 *
 * The second is the waiting line. The mock pulsed a dot at a machine that was
 * about to dial in, and no machine dials this hub -- the hub dials the server,
 * once it has been given an address and a token on the previous screen. So the
 * status line under the box is about the one thing on this panel that can fail,
 * which is the copy.
 */

/** The tabs, in the order a reader meets them. */
const TARGETS: readonly InstallTarget[] = ['linux', 'macos', 'installed'];

/**
 * What each tab is called. The labels name what is in front of the reader
 * rather than what the command does, because that is the question they can
 * answer without knowing anything about this product yet.
 */
const TARGET_LABELS = {
  linux: 'Linux',
  macos: 'macOS',
  installed: 'Already installed',
} as const satisfies Record<InstallTarget, string>;

/**
 * Mantine hands a tab change back as `string | null`, which is a claim about
 * what the reader clicked rather than one of our three. It is parsed here and
 * not in `install-command.ts`: the loose string belongs to the component
 * library, so the narrowing belongs on this side of it, and an unrecognised
 * value leaves the panel on the tab it was already on rather than blanking it.
 */
function installTargetFrom(value: string | null): InstallTarget | null {
  switch (value) {
    case 'linux':
    case 'macos':
    case 'installed':
      return value;
    default:
      return null;
  }
}

/** How the last copy went, or `null` before the reader has asked for one. */
type CopyOutcome =
  | { readonly kind: 'copied' }
  /** The seam's sentence, kept whole: it names what refused and why. */
  | { readonly kind: 'refused'; readonly sentence: string };

export interface EnrollPanelProps {
  readonly scheme: Scheme;
  /**
   * The reader saying they have been to that machine and back. The panel does
   * not pair anything itself -- it hands the step back its other branch, which
   * is the form.
   */
  readonly onHaveToken: () => void;
  /**
   * The system clipboard, injected by tests and by nothing else; the default
   * is the browser's, the same seam `SessionPane` takes. `navigator.clipboard`
   * is absent in jsdom and absent on any page served over plain HTTP, which is
   * exactly how a hub on a LAN address is read, so the case worth testing
   * hardest is the one where there is nothing to copy with.
   */
  readonly clipboard?: Clipboard | undefined;
}

export function EnrollPanel({
  scheme,
  onHaveToken,
  clipboard = browserClipboard,
}: EnrollPanelProps): JSX.Element {
  const [target, setTarget] = useState<InstallTarget>('linux');
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);

  /**
   * Copying, and saying which way it went. Both halves matter: a clipboard
   * that refused and a button that was never wired up look identical, and on a
   * phone -- where retyping a `curl` line is the worst thing this screen could
   * ask -- the refusal is the one a reader most needs told.
   *
   * It is handed the command the box is drawing rather than reading the target
   * again, so what is written is provably the string on screen.
   */
  async function copyCommand(command: string): Promise<void> {
    try {
      await clipboard.writeText(command);
      setOutcome({ kind: 'copied' });
    } catch (error) {
      setOutcome({ kind: 'refused', sentence: clipboardProblem('copy', error) });
    }
  }

  /**
   * Changing tabs drops the copy line. It is a sentence about a particular
   * command, and left standing over a different one it would tell the reader
   * they are holding something they are not.
   */
  function chooseTarget(value: string | null): void {
    const chosen = installTargetFrom(value);
    if (chosen === null) return;
    setTarget(chosen);
    setOutcome(null);
  }

  return (
    <Stack gap={20} maw={560}>
      <Stack gap={4}>
        <Title order={2} fz={20} c={colorForRole('text', scheme)}>
          Run a server on a machine
        </Title>
        <Text fz={14} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Works on macOS and Linux. The hub dials the server, so the server needs one port the hub
          can reach.
        </Text>
      </Stack>

      {/* `keepMounted={false}` against Mantine's default: the three notes are
          three different answers to what will keep this server up, and a panel
          that rendered all three -- hidden or not -- would put two answers the
          reader has to rule out into the page, into a find, and into a screen
          reader's run of the document. */}
      <Tabs value={target} onChange={chooseTarget} keepMounted={false} variant="pills">
        <Tabs.List>
          {TARGETS.map((each) => (
            <Tabs.Tab key={each} value={each}>
              {TARGET_LABELS[each]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {TARGETS.map((each) => (
          <Tabs.Panel key={each} value={each} pt={16}>
            <Stack gap={10}>
              {/* The promise is dropped deliberately: `copyCommand` ends in a
                  sentence on this panel either way, and that sentence is the
                  reporting. */}
              <CommandBox
                command={installCommand(each)}
                scheme={scheme}
                onCopy={(text) => void copyCommand(text)}
              />
              <CopyLine outcome={outcome} scheme={scheme} />
              <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
                {targetNotes(each)}
              </Text>
            </Stack>
          </Tabs.Panel>
        ))}
      </Tabs>

      <Stack gap={10} align="flex-start">
        <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Whichever of these you run, setup is the part that mints this server its identity file
          (~/.agentplex/server.json by default). The pairing token is in that file and shown nowhere
          else, so read it off that machine and bring it back here with the address.
        </Text>
        <Button variant="default" onClick={onHaveToken}>
          I have the token, pair it
        </Button>
      </Stack>
    </Stack>
  );
}

interface CommandBoxProps {
  readonly command: string;
  readonly scheme: Scheme;
  readonly onCopy: (command: string) => void;
}

/**
 * The command, as something to read and something to take.
 *
 * The prompt is `aria-hidden` and unselectable: it is there so the box reads as
 * a shell line at a glance, and it is not part of what anybody should end up
 * running. A reader who drags across the box gets the command; the Copy button
 * writes the same string, which is the thing the test pins.
 */
function CommandBox({ command, scheme, onCopy }: CommandBoxProps): JSX.Element {
  return (
    <Group
      gap={12}
      wrap="nowrap"
      align="center"
      p={12}
      style={{
        background: colorForRole('surfaceAlt', scheme),
        border: `1px solid ${colorForRole('border', scheme)}`,
        borderRadius: 10,
      }}
    >
      <Text
        aria-hidden
        ff="monospace"
        fz={13}
        c={colorForRole('textMuted', scheme)}
        style={{ userSelect: 'none' }}
      >
        $
      </Text>
      <Code
        block
        data-install-command
        fz={13}
        c={colorForRole('text', scheme)}
        style={{ flex: 1, minWidth: 0, background: 'transparent', padding: 0, overflowX: 'auto' }}
      >
        {command}
      </Code>
      <Button size="xs" variant="default" onClick={() => onCopy(command)}>
        Copy
      </Button>
    </Group>
  );
}

interface CopyLineProps {
  readonly outcome: CopyOutcome | null;
  readonly scheme: Scheme;
}

/**
 * The status line under the box: nothing until the reader asks for a copy, and
 * then which way it went, in a tone rather than a hue.
 *
 * Nothing rather than a placeholder, because before the button is pressed
 * there is no status -- a line reserving the space would be this panel
 * inventing something to say.
 */
function CopyLine({ outcome, scheme }: CopyLineProps): JSX.Element | null {
  if (outcome === null) return null;
  const copied = outcome.kind === 'copied';
  return (
    <Group gap={8} align="center" wrap="nowrap">
      <ToneDot tone={copied ? 'running' : 'blocked'} scheme={scheme} />
      <Text fz={12} c={colorForTone(copied ? 'running' : 'blocked', scheme)}>
        {copied ? 'Copied. Run it on the machine you want to add.' : outcome.sentence}
      </Text>
    </Group>
  );
}
