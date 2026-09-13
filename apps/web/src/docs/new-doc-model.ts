import {
  docNameSchema,
  type DocName,
  type FrameId,
  type MachineState,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type {
  ConnectionPhase,
  DocCreatedView,
  HubCommand,
  RefusalView,
} from '../store/hub-store.js';

/**
 * Every rule the New doc action follows, as functions of values.
 *
 * The form owns what the user typed, the machine they picked and the id of the
 * create it is waiting on; what may be typed, what may be picked, why the
 * button is disabled and what to do with the hub's answer are decided here,
 * where a test can hold them against captured hub output without a DOM.
 *
 * ## Why the name is parsed twice
 *
 * `docNameSchema` is the protocol's, and it is the schema the hub forwards to
 * the server unchanged -- so a name this form accepts is a name that machine
 * will accept. Running it here as well is not a second answer to what a name
 * is: it is the same answer, one round trip earlier, in front of the person
 * who typed it. The schema stays the authority, which is why this returns the
 * schema's own sentence rather than one written here.
 *
 * ## Which machine, and what this build cannot ask
 *
 * A document is a file on one machine's disk, so the machine is part of making
 * one and the hub has no business choosing it. What this offers is every
 * connected machine, and what it cannot offer is the narrower question -- which
 * of them has this project's directory. A client knows a project by its node
 * id and never by its path (`client.ts` says why a doc frame carries no
 * directory), so "the machines this checkout is on" is not a question this
 * build can ask. A machine that does not have it answers the create with the
 * refusal its own disk gives, and the form renders that sentence.
 */

/** A machine the New doc form offers: the stable id, worded by its label. */
export interface DocServerChoice {
  readonly id: ServerRegistrationId;
  readonly label: string;
}

/**
 * The machines that could hold a new document right now.
 *
 * Connected only, for the reason a browse offers connected machines only: the
 * hub holds no copy of a document, so a create aimed at a machine it cannot
 * reach is refused with a sentence, and offering a choice that can only be
 * refused is worse than not offering it.
 */
export function writableServers(state: MachineState | null): readonly DocServerChoice[] {
  if (state === null) return [];
  return state.servers
    .filter((server) => server.phase === 'connected')
    .map((server) => ({ id: server.registrationId, label: server.label }));
}

export type DocNameVerdict =
  { readonly ok: true; readonly name: DocName } | { readonly ok: false; readonly problem: string };

/**
 * The name as the protocol reads it, or the sentence that says why it is not
 * one.
 *
 * Trimmed first, because a trailing space is a typing accident rather than an
 * intention and the schema refuses one outright -- and refusing "plan.md " with
 * a sentence about path segments would be answering a question nobody asked.
 */
export function parseDocName(text: string): DocNameVerdict {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problem: 'give the document a name' };
  const parsed = docNameSchema.safeParse(trimmed);
  if (parsed.success) return { ok: true, name: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, problem: first?.message ?? 'that is not a document name' };
}

/**
 * The doc-create command, exactly the fields the frame defines.
 *
 * A new document starts empty rather than with a heading this app invented:
 * the file is the user's, and seeding it would mean the first thing they do to
 * a new document is delete something they did not write.
 */
export function buildDocCreate(
  projectId: NodeId,
  server: ServerRegistrationId,
  name: DocName,
): HubCommand {
  return { type: 'doc-create', projectId, server, name, content: '' };
}

/**
 * Why the create is disabled, in words, or `null` when it is not.
 *
 * The connection has to be up for the reason a project create needs one: the
 * store would queue the command, and a form that silently records intent for
 * later is the surprise the queue's own wording exists to soften.
 */
export function docCreateBlockedReason(
  phase: ConnectionPhase,
  name: string,
  server: ServerRegistrationId | null,
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
  const verdict = parseDocName(name);
  if (!verdict.ok) return verdict.problem;
  if (server === null) return 'pick the machine this document lives on';
  return null;
}

/**
 * What the form does with the hub's answer to the create it sent.
 *
 * `made` carries the node, because that is the one thing the client cannot work
 * out for itself and the one thing it immediately needs: every later frame
 * about this document names the node, and the form opens the editor on it.
 */
export type DocCreateFollowUp =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'made'; readonly nodeId: NodeId }
  | { readonly kind: 'refused'; readonly words: string };

export function docCreateFollowUp(
  pending: FrameId,
  lastCreated: DocCreatedView | null,
  lastRefusal: RefusalView | null,
): DocCreateFollowUp {
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastCreated !== null && lastCreated.replyTo === pending) {
    return { kind: 'made', nodeId: lastCreated.nodeId };
  }
  return { kind: 'waiting' };
}
