import { useState, type JSX } from 'react';
import type { Layout, NodeId, SessionRef } from '@agentplex/protocol';
import type { CommandOutcome } from '../store/commands.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Menu, Modal, Stack, Text, TextInput } from '../ui/components.js';
import { colorForRole, colorForToneText, type Scheme } from '../ui/tokens.js';
import {
  buildMove,
  buildRemove,
  buildRename,
  buildStop,
  menuOffers,
  moveTargets,
  parseNodeName,
  stopOffer,
  treeFollowUp,
  type TreeFollowUp,
} from './tree-model.js';

/**
 * What a person may do to one node: rename it, move it, take it out.
 *
 * The whole tree is AGX-134's; this is the three edits hanging off a row that
 * already exists, so that the mutations the hub grew are reachable before
 * anything draws a tree to drag things around in.
 *
 * Two things about it are decisions rather than layout. The move offers
 * containers and never an index -- a menu cannot honestly claim a person chose
 * where among the siblings, so the frame says the end and the hub clamps it.
 * And a refused removal opens a dialog rather than writing a line into the
 * row: the sentence is about something running on another machine, and the one
 * action that clears it is a stop aimed at that machine, which is a thing to
 * put a button next to rather than a footnote.
 *
 * Each of the three is drawn only where the hub would accept it, as
 * `menuOffers` reads the tree: a project has no move, and HOME, which the hub
 * lets nobody edit, has no trigger at all rather than a menu of refusals.
 *
 * Nothing here re-reads the tree afterwards. The hub broadcasts that the
 * catalogue changed and the store asks for the layout again, which is how
 * every other tab finds out too.
 */
export interface NodeMenuProps {
  readonly store: HubStore;
  readonly nodeId: NodeId;
  /** What the node is called now, which is what a rename starts from. */
  readonly name: string;
  /** The tree, for the containers a move may offer. */
  readonly layout: Layout | null;
  /** The session this node points at, so a refused removal can offer the stop. */
  readonly anchor: SessionRef | null;
  readonly scheme: Scheme;
}

export function NodeMenu({
  store,
  nodeId,
  name,
  layout,
  anchor,
  scheme,
}: NodeMenuProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  const [pending, setPending] = useState<CommandOutcome | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  /** The store's own "no", which is not the hub's and reads differently. */
  const [rejected, setRejected] = useState<string | null>(null);

  const offers = menuOffers(layout, nodeId);
  const targets = offers.move ? moveTargets(layout, nodeId) : [];

  const followUp: TreeFollowUp | null =
    pending === null || !pending.accepted ? null : treeFollowUp(pending.id, snapshot.answers);
  const refused = followUp?.kind === 'refused' ? followUp : null;
  const stoppable = followUp === null ? null : stopOffer(followUp);

  function send(command: Parameters<HubStore['sendCommand']>[0]): void {
    setRejected(null);
    const outcome = store.sendCommand(command);
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome);
  }

  function submitRename(): void {
    const parsed = parseNodeName(draft);
    if (parsed === null) return;
    setRenaming(false);
    send(buildRename(nodeId, parsed));
  }

  // After every hook, so that a node that gains or loses its offers between
  // renders keeps the same hook order.
  if (!offers.rename && !offers.move && !offers.remove) return null;

  return (
    <>
      <Menu position="bottom-end" withinPortal shadow="md" width={220}>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            color={colorForRole('textMuted', scheme)}
            aria-label={`Actions for ${name}`}
          >
            {'...'}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {offers.rename ? (
            <Menu.Item
              onClick={() => {
                setDraft(name);
                setRenaming(true);
              }}
            >
              Rename
            </Menu.Item>
          ) : null}
          {offers.move ? (
            <>
              <Menu.Label>Move to</Menu.Label>
              {targets.map((target) => (
                <Menu.Item
                  key={target.parentId}
                  onClick={() => send(buildMove(nodeId, target.parentId))}
                >
                  {target.label}
                </Menu.Item>
              ))}
            </>
          ) : null}
          {offers.remove ? (
            <>
              {offers.rename || offers.move ? <Menu.Divider /> : null}
              <Menu.Item onClick={() => send(buildRemove(nodeId))}>Remove from tree</Menu.Item>
            </>
          ) : null}
        </Menu.Dropdown>
      </Menu>

      <Modal opened={renaming} onClose={() => setRenaming(false)} title="Rename" centered>
        <Stack gap="sm">
          <TextInput
            label="Name"
            aria-label="Name"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button onClick={submitRename} disabled={parseNodeName(draft) === null}>
              Rename
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={refused !== null || rejected !== null}
        onClose={() => {
          setPending(null);
          setRejected(null);
        }}
        title="The hub said no"
        centered
      >
        <Stack gap="sm">
          <Text fz={13} style={{ color: colorForToneText('blocked', scheme) }}>
            {refused?.words ?? rejected}
          </Text>
          {stoppable === null || anchor === null ? null : (
            <Text fz={12} c={colorForRole('textMuted', scheme)}>
              Stopping it kills the process and leaves the transcript where it is.
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            {stoppable === null || anchor === null ? null : (
              <Button
                variant="default"
                onClick={() => {
                  setPending(null);
                  store.sendCommand(buildStop(anchor));
                }}
              >
                Stop it
              </Button>
            )}
            <Button
              onClick={() => {
                setPending(null);
                setRejected(null);
              }}
            >
              Close
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
