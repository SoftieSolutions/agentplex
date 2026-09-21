import { useEffect, useState, type JSX } from 'react';
import { nodeIdSchema, storeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import type { FrameId, NodeId, SessionRef, StoreId } from '@agentplex/protocol';
import { projectChoices } from '../projects/new-project-model.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Modal, Select, Stack, Text, Textarea } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import { StopButton } from './stop-button.js';
import {
  buildStart,
  deliveryWords,
  providerOffer,
  resolveProvider,
  serverOverrideChoices,
  startFollowUp,
  startableStores,
  submitBlockedReason,
  type StartFollowUp,
} from './new-session-model.js';

/** A start this form is waiting on, and the session it named (usually none). */
interface PendingStart {
  readonly outcome: ReturnType<HubStore['sendCommand']>;
  readonly asked: SessionRef | null;
}

/**
 * The new-session form, in the mockup's dialog language (turn 7): a store, a
 * provider, an optional project, an optional machine override, an optional
 * first prompt. Every rule -- which controls exist, what the frame carries,
 * what to do with the hub's answer -- comes from new-session-model.ts; this
 * component owns only what the user has typed and the id of the start it is
 * waiting on.
 *
 * The mockup's New popover lists five node kinds and the chrome draws it now
 * (AGX-124): its Session row is what opens this form in the wide shell, and
 * the phone's action button is what opens it below the breakpoint. There is
 * one of this form in the page and the shell owns it. The session list held a
 * second copy wired without `onPending`, so whether a start opened a pane
 * depended on which of two controls a person happened to press.
 *
 * The order the four choices are resolved in is the design, not an accident of
 * where the lines sit. The machine is resolved first, against the store's live
 * candidates; the provider offer is then that machine's answer, or the union
 * over the store when the hub is placing; and the machine list is then narrowed
 * to what can start the resolved provider. Read that way the two selects
 * constrain each other in both directions and cannot argue: whatever provider
 * comes out of the offer, the chosen machine can start it, so the narrowing
 * never drops the machine that produced it.
 *
 * The project control is drawn only once there is a project to pick, and it
 * narrows nothing: nothing on the wire ties a project to a machine. What
 * picking one changes is the frame, which carries the project's id, and the hub
 * resolves the directory out of its own rows.
 */
export interface NewSessionFormProps {
  readonly store: HubStore;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
  /** How the pane route is entered, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
  /**
   * Opens a pane on the start that has just gone out, by the handle it has:
   * the id of the `session-start` frame itself.
   *
   * Called the moment the command is accepted, not when the hub answers,
   * because that is the point of the pane: a spawn produces output from the
   * fork onwards and the only name it has until the provider writes one is
   * this handle. Everything the hub goes on to say about that start -- the
   * machine it went to, a refusal, the session it turned out to be -- is
   * correlated by the same id, in the pane rather than here.
   *
   * Optional, and this form works without it: a screen with no layout to open
   * a pane in still starts sessions, and still says what happened.
   */
  readonly onPending?: (startId: FrameId) => void;
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
  onPending,
}: NewSessionFormProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  // Interest in the tree, declared for as long as this form is mounted: the
  // projects it offers are nodes in it, and nothing else on this screen asks.
  const layout = useHubLayout(store);
  const [storeChoice, setStoreChoice] = useState<string | null>(null);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [serverChoice, setServerChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  /**
   * The start awaiting an answer, or `null` while none is.
   *
   * The session it named travels with it, because a refusal that names a
   * holder is answered about that session and a stop has to be aimed at it.
   * Today it is always `null` -- this form only starts new sessions -- and it
   * is carried rather than assumed so the day a resume sends one, the refusal
   * leads somewhere instead of only saying no.
   */
  const [pending, setPending] = useState<PendingStart | null>(null);
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

  // Resolved against the unnarrowed candidates, before the provider it will
  // then be narrowed by: see this file's header for why that order is what
  // keeps the two selects from arguing.
  const candidates = serverOverrideChoices(state, chosenStore);
  const chosenServer =
    serverChoice !== null && candidates.some((choice) => choice.id === serverChoice)
      ? serverRegistrationIdSchema.parse(serverChoice)
      : null;

  const offer = providerOffer(state, chosenStore, chosenServer);
  const chosenProvider = resolveProvider(offer, providerChoice);
  const caveat = offer.options.find((option) => option.provider === chosenProvider)?.caveat ?? null;
  const overrides = serverOverrideChoices(state, chosenStore, chosenProvider);

  const blocked = submitBlockedReason(snapshot.phase, stores, chosenStore, offer, chosenProvider);
  const followUp: StartFollowUp | null =
    pending === null || !pending.outcome.accepted
      ? null
      : startFollowUp(
          pending.outcome.id,
          snapshot.lastStarted,
          snapshot.lastRefusal,
          state,
          pending.asked,
        );

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
    setProviderChoice(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  function submit(): void {
    if (chosenStore === null || chosenProvider === null) return;
    setRejected(null);
    const command = buildStart(chosenStore, chosenProvider, chosenServer, prompt, chosenProject);
    const outcome = store.sendCommand(command);
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending({
      outcome,
      asked:
        command.type === 'session-start' && command.sessionId !== null
          ? { storeId: command.storeId, sessionId: command.sessionId }
          : null,
    });
    // In the click that sent it, so the pane is open before the hub has
    // answered -- which is the whole of what a pending pane is for. Nothing
    // here waits for a reply, and nothing navigates: the route stays an
    // address for sessions that exist.
    onPending?.(outcome.id);
  }

  const waiting = followUp?.kind === 'waiting';
  const started = followUp?.kind === 'started' ? followUp.words : null;
  const refusal = followUp?.kind === 'refused' ? followUp : null;
  const queued =
    pending !== null && pending.outcome.accepted && waiting
      ? deliveryWords(pending.outcome.delivery)
      : null;

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

        {offer.options.length >= 2 ? (
          // Two or more, so there is a question to ask. The list is what the
          // chosen machine -- or the store's live machines, when the hub is
          // placing -- reported in its handshake, never a constant.
          <Select
            label="Provider"
            aria-label="Provider"
            placeholder="Choose a provider"
            data={offer.options.map((option) => option.provider)}
            value={chosenProvider}
            onChange={setProviderChoice}
          />
        ) : chosenProvider !== null ? (
          // One provider is not a choice: it is named in words instead.
          <Text fz={13} c="dimmed">
            provider: {chosenProvider}
          </Text>
        ) : null}

        {caveat === null ? null : (
          // Startable, and something about it could not be read. Beside the
          // control it concerns, in the tone that means look rather than stop.
          <Text fz={12} style={{ color: colorForTone('needs-you', scheme) }}>
            {caveat}
          </Text>
        )}
        {offer.problems.map((words) => (
          // Why a provider is not on the list, in the words of the machine that
          // took the reading. An install, a login and a build with no adapters
          // are three different things to go and do.
          <Text key={words} fz={12} c="dimmed">
            {words}
          </Text>
        ))}

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
        {refusal === null ? null : (
          <Stack gap={6}>
            <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
              {refusal.words}
            </Text>
            {refusal.held === null ? null : (
              // The machine, named by this client's own lookup rather than read
              // out of the hub's sentence, and the way out beside it. The
              // button draws itself only for a holder that can be stopped.
              <Group gap={8} align="center">
                <Text fz={12} c="dimmed">
                  held by {refusal.held.machine}
                </Text>
                {refusal.held.session === null ? null : (
                  <StopButton
                    store={store}
                    sessionRef={refusal.held.session}
                    holder={refusal.held.holder}
                    scheme={scheme}
                  />
                )}
              </Group>
            )}
          </Stack>
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
