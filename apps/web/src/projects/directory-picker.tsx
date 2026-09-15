import { useState, type JSX } from 'react';
import type { DirectoryEntry, FrameId, ServerRegistrationId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Button, Group, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import {
  breadcrumb,
  browseFor,
  chooseBlockedReason,
  descendTo,
  pickerView,
  truncationNotice,
} from './directory-picker-model.js';

/**
 * Picking a directory on one server by walking it.
 *
 * A project holds a directory on a machine, and this is how somebody says
 * which. It starts at that server's browse roots -- the client does not know
 * what a machine will allow and must not guess -- and every step down is
 * another `directory-list` through the store's command path, answered by the
 * server that owns the disk.
 *
 * Not mounted anywhere yet, on purpose. AGX-133 puts it in the project form,
 * which is the screen that has somewhere to put the answer; shipping it wired
 * to a form that cannot save one would be a control that does nothing.
 *
 * Every rule is in `directory-picker-model.ts`: what a breadcrumb step is, what
 * descending into an entry means, and which answer belongs to which question.
 * This component owns the id of the browse it is waiting on and the fact that
 * a click sends one -- and nothing else, which is what makes the rules
 * testable without a DOM.
 */
export interface DirectoryPickerProps {
  readonly store: HubStore;
  /** The machine being browsed. A directory is a fact about one of them. */
  readonly server: ServerRegistrationId;
  readonly scheme: Scheme;
  /** Called with an absolute path when the user confirms one. */
  readonly onChoose: (directory: string) => void;
}

/** Outside the component: an entry's look is a function of what it is. */
function entryTone(entry: DirectoryEntry, scheme: Scheme): string {
  return entry.kind === 'directory'
    ? colorForRole('text', scheme)
    : colorForRole('textMuted', scheme);
}

/** Outside the component: what a kind is called in front of a person. */
function entryKindLabel(entry: DirectoryEntry): string {
  if (entry.kind === 'directory') return '';
  // A link is `other` on the wire because the server will not follow one. That
  // is worth saying rather than leaving as a row that quietly does not respond
  // to a click.
  return entry.kind === 'file' ? 'file' : 'not a directory';
}

export function DirectoryPicker({
  store,
  server,
  scheme,
  onChoose,
}: DirectoryPickerProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  /** The id of the browse awaiting an answer, or `null` before the first. */
  const [pending, setPending] = useState<FrameId | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const view = pickerView(snapshot, pending);
  const listing = view.kind === 'listing' ? view.listing : null;
  const blocked = chooseBlockedReason(view);
  const muted = colorForRole('textMuted', scheme);

  function browse(directory: string | null): void {
    setRejected(null);
    const outcome = store.sendCommand(browseFor(server, directory));
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome.id);
  }

  // No effect opens the first browse. The store is read through
  // `useSyncExternalStore` and a render may not send a frame, so the roots are
  // asked for by the one thing that is allowed to ask: a person pressing the
  // button below. It is also the honest first screen -- a picker that browsed
  // on mount would put a request on the wire for a dialog nobody has opened.
  return (
    <Stack gap="xs">
      <Group gap={4} wrap="wrap">
        {(listing === null
          ? [{ label: 'roots', directory: null }]
          : breadcrumb(listing.directory, listing.roots)
        ).map((step) => (
          <UnstyledButton
            key={step.directory ?? 'roots'}
            aria-label={`Browse ${step.directory ?? 'the roots'}`}
            onClick={() => {
              browse(step.directory);
            }}
            style={{ color: muted, fontSize: 12 }}
          >
            {step.label} /
          </UnstyledButton>
        ))}
      </Group>

      {view.kind === 'idle' ? (
        <Button
          onClick={() => {
            browse(null);
          }}
        >
          Browse this machine
        </Button>
      ) : null}

      {view.kind === 'waiting' ? (
        <Text fz={13} c="dimmed">
          asking that machine
        </Text>
      ) : null}

      {view.kind === 'refused' ? (
        <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
          {view.words}
        </Text>
      ) : null}

      {rejected === null ? null : (
        <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
          {rejected}
        </Text>
      )}

      {listing === null ? null : (
        <Stack gap={2}>
          {listing.entries.length === 0 ? (
            <Text fz={13} c="dimmed">
              this directory is empty
            </Text>
          ) : null}
          {listing.entries.map((entry) => {
            const into = descendTo(listing, entry);
            return (
              <Box key={entry.name}>
                <UnstyledButton
                  aria-label={entry.name}
                  disabled={into === null}
                  onClick={() => {
                    if (into !== null) browse(into);
                  }}
                  style={{ color: entryTone(entry, scheme), fontSize: 13 }}
                >
                  <Group gap={8}>
                    <Text fz={13}>{entry.name}</Text>
                    <Text fz={11} c="dimmed">
                      {entryKindLabel(entry)}
                    </Text>
                  </Group>
                </UnstyledButton>
              </Box>
            );
          })}
        </Stack>
      )}

      {listing === null || truncationNotice(listing) === null ? null : (
        <Text fz={12} c="dimmed">
          {truncationNotice(listing)}
        </Text>
      )}

      <Group justify="flex-end" gap="xs">
        <Button
          disabled={blocked !== null || listing === null || listing.directory === null}
          onClick={() => {
            if (listing !== null && listing.directory !== null) onChoose(listing.directory);
          }}
        >
          Use this directory
        </Button>
      </Group>

      {blocked === null ? null : (
        <Text fz={13} c="dimmed">
          {blocked}
        </Text>
      )}
    </Stack>
  );
}
