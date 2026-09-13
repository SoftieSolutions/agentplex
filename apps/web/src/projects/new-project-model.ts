import type { FrameId, Layout, MachineState, ServerRegistrationId } from '@agentplex/protocol';
import type { HubCommand, ProjectCreatedView, RefusalView } from '../store/hub-store.js';
import { PROJECT_KIND } from './project-kind.js';

/**
 * Every rule the new-project form follows, as functions of values.
 *
 * The form owns what the user has typed and the id of the create it is waiting
 * on. What a machine may be browsed, what the frame carries, why submit is
 * disabled and what to do with the hub's answer are all decided here, where a
 * test can hold a captured state against them without a DOM.
 *
 * The one thing worth reading twice is what the server choice is *for*. A
 * project is not tied to a machine -- the same checkout may be at the same path
 * on three of them, and the one that is awake today need not be the one that
 * runs it tomorrow -- so the machine picked here is the machine being *browsed*
 * and nothing else. It is not stored, it is not sent, and the frame has nowhere
 * to put it.
 */

/** A machine the browse control offers: the stable id, worded by its label. */
export interface BrowseChoice {
  readonly id: ServerRegistrationId;
  readonly label: string;
}

/**
 * The machines whose disks can be looked at right now.
 *
 * Connected only. A browse of a machine the hub cannot reach is refused with a
 * sentence, and offering a choice that can only be refused is worse than not
 * offering it. Unlike the new-session form's override, one candidate is still
 * drawn: it is not a choice being made between machines, it is the answer to
 * "whose disk am I looking at", and a person browsing deserves to know.
 */
export function browsableServers(state: MachineState | null): readonly BrowseChoice[] {
  if (state === null) return [];
  return state.servers
    .filter((server) => server.phase === 'connected')
    .map((server) => ({ id: server.registrationId, label: server.label }));
}

/** The name as the hub will read it: a name of spaces is the absence of one. */
export function parseProjectName(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** The project-create command, exactly the fields the frame defines. */
export function buildProjectCreate(name: string, directory: string): HubCommand {
  return { type: 'project-create', name: name.trim(), directory };
}

/**
 * Why submit is disabled, in words, or `null` when it is not.
 *
 * The connection has to be up for the reason a start needs one: the store would
 * queue the command, but a form that silently records intent for later is the
 * surprise the queue's own wording exists to soften.
 */
export function createBlockedReason(
  phase: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed',
  name: string,
  directory: string | null,
): string | null {
  switch (phase) {
    case 'idle':
      return 'not connected to the hub';
    case 'connecting':
      return 'still connecting to the hub';
    case 'reconnecting':
      return 'the connection to the hub is down; reconnecting';
    case 'failed':
      return 'the connection has failed and is not retrying';
    case 'connected':
      break;
  }
  if (parseProjectName(name) === null) return 'give the project a name';
  if (directory === null) return 'browse to the directory this project is';
  return null;
}

/**
 * What the form does with the hub's answer to the create it sent.
 *
 * `made` rather than a navigation, because there is nowhere to go: a project is
 * a node in a tree the sidebar draws, and this milestone has no route for one.
 * What the user needs is the confirmation and the form out of the way.
 */
export type CreateFollowUp =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'made'; readonly words: string }
  | { readonly kind: 'refused'; readonly words: string };

export function createFollowUp(
  pending: FrameId,
  lastCreated: ProjectCreatedView | null,
  lastRefusal: RefusalView | null,
): CreateFollowUp {
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastCreated !== null && lastCreated.replyTo === pending) {
    return { kind: 'made', words: 'the project is in your tree' };
  }
  return { kind: 'waiting' };
}

/** One project, as a picker offers it. */
export interface ProjectChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * Every project in the tree, in the order the hub sent it.
 *
 * Read off the layout rather than held in a collection of its own, because that
 * is what a project is: a node. A project the user renamed is a project with a
 * different label here on the next layout and the same id, which is why
 * everything downstream names one by id.
 *
 * An unnamed project cannot happen -- the hub refuses a blank name -- so a node
 * with no name is skipped rather than shown as a blank row: a picker option a
 * person cannot read is one they cannot choose on purpose.
 */
export function projectChoices(layout: Layout | null): readonly ProjectChoice[] {
  if (layout === null) return [];
  const choices: ProjectChoice[] = [];
  for (const node of layout) {
    if (node.kind !== PROJECT_KIND || node.name === null) continue;
    choices.push({ id: node.id, label: node.name });
  }
  return choices;
}
