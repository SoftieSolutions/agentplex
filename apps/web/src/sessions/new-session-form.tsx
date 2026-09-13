import { useEffect, useState, type JSX } from 'react';
import { nodeIdSchema, storeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import type { NodeId, StoreId } from '@agentplex/protocol';
import { projectChoices } from '../projects/new-project-model.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Modal, Select, Stack, Text, Textarea } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import {
  buildStart,
  deliveryWords,
  serverOverrideChoices,
  startFollowUp,
  startableStores,
  submitBlockedReason,
  type StartFollowUp,
} from './new-session-model.js';

/**
 * The new-session form, in the mockup's dialog language (turn 7): a store, an
 * optional machine override, an optional first prompt. Every rule -- which
 * controls exist, what the frame carries, what to do with the hub's answer --
 * comes from new-session-model.ts; this component owns only what the user has
 * typed and the id of the start it is waiting on.
 *
 * The mockup's New popover lists five node kinds, but only Session is live in
 * this milestone, and a menu with one live option is not drawn: the button
 * opens this form directly.
 *
 * The project control is drawn only once there is a project to pick, and
 * picking one changes two things: the start carries the project's id, and the
 * machine list narrows to the machines that could actually run it. Both are the
 * hub's rules reflected rather than invented here -- the hub resolves the
 * directory out of its own rows, and refuses a machine that does not run the
 * provider -- which is why the reasons live in `new-session-model.ts`.
 */
export interface NewSessionFormProps {
  readonly store: HubStore;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
  /** How the pane route is entered, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

// Outside the component: it touches nothing but the browser it runs in.
function assignHash(hash: string): void {
  window.location.hash = hash;
}

export function NewSessionForm({
  store,
  opened,
  onClose,
  scheme,
  navigate = assignHash,
}: NewSessionFormProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  // Interest in the tree, declared for as long as this form is mounted: the
  // projects it offers are nodes in it, and nothing else on this screen asks.
  const layout = useHubLayout(store);
  const [storeChoice, setStoreChoice] = useState<string | null>(null);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [serverChoice, setServerChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  /** The id of the start awaiting an answer, or `null` while none is. */
  const [pending, setPending] = useState<ReturnType<HubStore['sendCommand']> | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const state = snapshot.machineState;
  const stores = state === null ? [] : startableStores(state);

  // The choice survives in state in case its option returns, but only a store
  // the current frame offers reaches the pipeline; one store needs no choosing.
  const offered = storeChoice !== null && stores.some((id) => id === storeChoice);
  const chosenStore: StoreId | null =
    stores.length === 1 ? (stores[0] ?? null) : offered ? storeIdSchema.parse(storeChoice) : null;

  const projects = projectChoices(layout);
  const chosenProject: NodeId | null =
    projectChoice !== null && projects.some((choice) => choice.id === projectChoice)
      ? nodeIdSchema.parse(projectChoice)
      : null;

  // Narrowed by the provider only when a project is chosen: see
  // `serverOverrideChoices` for why the hub's own filtering covers the rest.
  const overrides =
    state === null
      ? []
      : serverOverrideChoices(state, chosenStore, chosenProject === null ? null : 'claude');
  const chosenServer =
    serverChoice !== null && overrides.some((choice) => choice.id === serverChoice)
      ? serverRegistrationIdSchema.parse(serverChoice)
      : null;

  const blocked = submitBlockedReason(snapshot.phase, stores, chosenStore);
  const followUp: StartFollowUp | null =
    pending === null || !pending.accepted
      ? null
      : startFollowUp(pending.id, snapshot.lastStarted, snapshot.lastRefusal, state);

  const paneHash = followUp?.kind === 'navigate' ? followUp.hash : null;
  // useEffect, justified: entering the pane route is an imperative browser
  // side effect answering an asynchronous hub reply. The snapshot arrives
  // through useSyncExternalStore; no render can perform the navigation, and no
  // user event carries it -- the reply does.
  useEffect(() => {
    if (paneHash === null) return;
    setPending(null);
    navigate(paneHash);
  }, [paneHash, navigate]);

  function reset(): void {
    setPending(null);
    setRejected(null);
    setPrompt('');
    setServerChoice(null);
    setProjectChoice(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  function submit(): void {
    if (chosenStore === null) return;
    setRejected(null);
    const outcome = store.sendCommand(buildStart(chosenStore, chosenServer, prompt, chosenProject));
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome);
  }

  const waiting = followUp?.kind === 'waiting';
  const started = followUp?.kind === 'started' ? followUp.words : null;
  const refused = followUp?.kind === 'refused' ? followUp.words : null;
  const queued =
    pending !== null && pending.accepted && waiting ? deliveryWords(pending.delivery) : null;

  return (
    <Modal opened={opened} onClose={close} title="New session" centered>
      <Stack gap="sm">
        {stores.length >= 2 ? (
          <Select
            label="Store"
            aria-label="Store"
            placeholder="Choose a store"
            data={[...stores]}
            value={chosenStore}
            onChange={setStoreChoice}
          />
        ) : chosenStore !== null ? (
          // One store is not a choice: it is named in words instead.
          <Text fz={13} c="dimmed">
            in store {chosenStore}
          </Text>
        ) : (
          <Text fz={13} c="dimmed">
            no paired server reports a store to start in
          </Text>
        )}

        {projects.length === 0 ? null : (
          // Drawn from the first project onwards, because "in this project" and
          // "wherever the store is" are two different starts. Clearable, and
          // empty is the second of them rather than a missing answer.
          <Select
            label="Project"
            aria-label="Project"
            placeholder="No project"
            data={projects.map((choice) => ({ value: choice.id, label: choice.label }))}
            value={chosenProject}
            onChange={setProjectChoice}
            clearable
          />
        )}

        {overrides.length === 0 ? null : (
          // Drawn only when more than one connected machine could run the
          // store; empty means the hub's pick, which is the default way to ask.
          <Select
            label="Machine"
            aria-label="Machine"
            placeholder="Let the hub choose"
            data={overrides.map((choice) => ({ value: choice.id, label: choice.label }))}
            value={chosenServer}
            onChange={setServerChoice}
            clearable
          />
        )}

        <Textarea
          label="Prompt"
          aria-label="Prompt"
          placeholder="Optional first prompt"
          autosize
          minRows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />

        {/* On the frame, but one provider is not a choice to draw. */}
        <Text fz={12} c="dimmed">
          provider: claude
        </Text>

        {blocked === null ? null : (
          <Text fz={13} c="dimmed">
            {blocked}
          </Text>
        )}
        {queued === null ? null : (
          <Text fz={13} c="dimmed">
            {queued}
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
        {started === null ? null : (
          <Text fz={13} style={{ color: colorForTone('running', scheme) }}>
            {started}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          {started === null ? (
            <Button onClick={submit} disabled={blocked !== null || waiting}>
              Start session
            </Button>
          ) : (
            <Button onClick={close}>Done</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
