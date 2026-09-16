import { useEffect, useState, type JSX } from 'react';
import {
  serverRegistrationIdSchema,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import { docHash } from './doc-route.js';
import {
  buildDocCreate,
  docCreateBlockedReason,
  docCreateFollowUp,
  parseDocName,
  writableServers,
  type DocCreateFollowUp,
} from './new-doc-model.js';

/**
 * The New doc form: a name, and the machine the file lands on.
 *
 * The name is checked against the protocol's own schema as it is typed, so
 * `../secrets.md` is refused in front of the person who typed it rather than
 * after a round trip -- and the sentence shown is the schema's, because the
 * schema is the authority on both ends.
 *
 * The machine is drawn as a choice only when there is one to make. One
 * connected machine is named in words instead: a control with a single option
 * is a decision nobody is being asked to take. What this build cannot narrow
 * is which of several machines has this project's checkout -- a client knows a
 * project by its node id and never by its path -- so the list is every
 * connected machine, and one that does not have the directory answers with the
 * refusal its own disk gives.
 */
export interface NewDocFormProps {
  readonly store: HubStore;
  readonly projectId: NodeId;
  readonly projectLabel: string;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
  /** How the document route is entered, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

// Outside the component: it touches nothing but the browser it runs in.
function assignHash(hash: string): void {
  window.location.hash = hash;
}

export function NewDocForm({
  store,
  projectId,
  projectLabel,
  opened,
  onClose,
  scheme,
  navigate = assignHash,
}: NewDocFormProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  const [name, setName] = useState('');
  const [serverChoice, setServerChoice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReturnType<HubStore['sendCommand']> | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const servers = writableServers(snapshot.machineState);
  // The choice survives in state in case its option returns, but only a machine
  // the current frame offers is used; one machine needs no choosing.
  const offered = serverChoice !== null && servers.some((choice) => choice.id === serverChoice);
  const chosen: ServerRegistrationId | null =
    servers.length === 1
      ? (servers[0]?.id ?? null)
      : offered
        ? serverRegistrationIdSchema.parse(serverChoice)
        : null;

  const blocked = docCreateBlockedReason(snapshot.phase, name, chosen);
  const followUp: DocCreateFollowUp | null =
    pending === null || !pending.accepted
      ? null
      : docCreateFollowUp(pending.id, snapshot.lastDocCreated, snapshot.lastRefusal);

  const made = followUp?.kind === 'made' ? followUp.nodeId : null;
  // useEffect, justified, and the same justification the new-session form
  // carries: opening the new document is an imperative browser navigation
  // answering an asynchronous hub reply. The reply arrives through
  // useSyncExternalStore, so no render may perform it and no user event
  // carries it.
  useEffect(() => {
    if (made === null) return;
    setPending(null);
    setName('');
    onClose();
    navigate(docHash(made));
  }, [made, navigate, onClose]);

  function close(): void {
    setPending(null);
    setRejected(null);
    setName('');
    onClose();
  }

  function submit(): void {
    const parsed = parseDocName(name);
    if (!parsed.ok || chosen === null) return;
    setRejected(null);
    const outcome = store.sendCommand(buildDocCreate(projectId, chosen, parsed.name));
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome);
  }

  const waiting = followUp?.kind === 'waiting';
  const refused = followUp?.kind === 'refused' ? followUp.words : null;

  return (
    <Modal opened={opened} onClose={close} title={`New doc in ${projectLabel}`} centered>
      <Stack gap="sm">
        <TextInput
          label="Name"
          aria-label="Name"
          placeholder="plan.md"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />

        {servers.length === 0 ? (
          <Text fz={13} c="dimmed">
            no paired server is connected, and a document is a file on one machine
          </Text>
        ) : servers.length === 1 ? (
          // One machine is not a choice: it is named in words instead.
          <Text fz={13} c="dimmed">
            on {servers[0]?.label}
          </Text>
        ) : (
          <Select
            label="Machine"
            aria-label="Machine"
            placeholder="Which machine holds this file"
            data={servers.map((choice) => ({ value: choice.id, label: choice.label }))}
            value={chosen}
            onChange={setServerChoice}
          />
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

        <Group justify="flex-end" gap="xs">
          <Button onClick={submit} disabled={blocked !== null || waiting}>
            Create doc
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
