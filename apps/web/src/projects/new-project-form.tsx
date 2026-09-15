import { useState, type JSX } from 'react';
import { serverRegistrationIdSchema } from '@agentplex/protocol';
import type { ServerRegistrationId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import { DirectoryPicker } from './directory-picker.js';
import {
  browsableServers,
  buildProjectCreate,
  createBlockedReason,
  createFollowUp,
  type CreateFollowUp,
} from './new-project-model.js';

/**
 * The new-project form: a name, a machine to look on, and a directory walked to
 * on it.
 *
 * The order of the controls is the order of the decisions, and the middle one
 * is the one that reads oddly until you know why it is there. A project is not
 * tied to a machine -- the same checkout may sit at the same path on three of
 * them -- so the machine chosen here is the machine whose disk is being
 * browsed, and it goes nowhere near the frame. It is worded as browsing rather
 * than as choosing for exactly that reason.
 *
 * Every rule is in `new-project-model.ts`; this component owns what the user
 * has typed, the directory they have walked to, and the id of the create it is
 * waiting on.
 */
export interface NewProjectFormProps {
  readonly store: HubStore;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
}

export function NewProjectForm({
  store,
  opened,
  onClose,
  scheme,
}: NewProjectFormProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  const [name, setName] = useState('');
  const [serverChoice, setServerChoice] = useState<string | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [pending, setPending] = useState<ReturnType<HubStore['sendCommand']> | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const servers = browsableServers(snapshot.machineState);
  // The choice survives in state in case its option returns, but only a machine
  // the current frame offers reaches the picker; one machine needs no choosing.
  const offered = serverChoice !== null && servers.some((choice) => choice.id === serverChoice);
  const browsing: ServerRegistrationId | null =
    servers.length === 1
      ? (servers[0]?.id ?? null)
      : offered
        ? serverRegistrationIdSchema.parse(serverChoice)
        : null;

  const blocked = createBlockedReason(snapshot.phase, name, directory);
  const followUp: CreateFollowUp | null =
    pending === null || !pending.accepted
      ? null
      : createFollowUp(pending.id, snapshot.lastProjectCreated, snapshot.lastRefusal);

  function close(): void {
    setPending(null);
    setRejected(null);
    setName('');
    setDirectory(null);
    onClose();
  }

  function submit(): void {
    if (directory === null) return;
    setRejected(null);
    const outcome = store.sendCommand(buildProjectCreate(name, directory));
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome);
  }

  const waiting = followUp?.kind === 'waiting';
  const made = followUp?.kind === 'made' ? followUp.words : null;
  const refused = followUp?.kind === 'refused' ? followUp.words : null;

  return (
    <Modal opened={opened} onClose={close} title="New project" centered>
      <Stack gap="sm">
        <TextInput
          label="Name"
          aria-label="Name"
          placeholder="What this project is called"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />

        {servers.length === 0 ? (
          <Text fz={13} c="dimmed">
            no paired server is connected, so there is no disk to browse
          </Text>
        ) : servers.length === 1 ? (
          // One machine is not a choice: it is named in words instead.
          <Text fz={13} c="dimmed">
            browsing {servers[0]?.label}
          </Text>
        ) : (
          <Select
            label="Browse"
            aria-label="Browse"
            placeholder="Which machine to look on"
            data={servers.map((choice) => ({ value: choice.id, label: choice.label }))}
            value={browsing}
            onChange={setServerChoice}
          />
        )}

        {browsing === null ? null : (
          <DirectoryPicker
            store={store}
            server={browsing}
            scheme={scheme}
            onChoose={setDirectory}
          />
        )}

        {directory === null ? null : (
          <Text fz={13} c="dimmed">
            directory: {directory}
          </Text>
        )}

        {blocked === null ? null : (
          <Text fz={13} c="dimmed">
            {blocked}
          </Text>
        )}
        {rejected === null ? null : (
          <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
            {rejected}
          </Text>
        )}
        {refused === null ? null : (
          <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
            {refused}
          </Text>
        )}
        {made === null ? null : (
          <Text fz={13} style={{ color: colorForTone('running', scheme) }}>
            {made}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          {made === null ? (
            <Button onClick={submit} disabled={blocked !== null || waiting}>
              Create project
            </Button>
          ) : (
            <Button onClick={close}>Done</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
