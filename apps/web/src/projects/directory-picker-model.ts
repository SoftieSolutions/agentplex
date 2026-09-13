import type { DirectoryEntry, FrameId, ServerRegistrationId } from '@agentplex/protocol';
import type {
  DirectoryListingView,
  HubCommand,
  HubSnapshot,
  RefusalView,
} from '../store/hub-store.js';

/**
 * Every rule the directory picker follows, as functions of values.
 *
 * The component beside this owns what the user has clicked and the id of the
 * browse it is waiting on, and nothing else: what a step in a breadcrumb is,
 * what descending into an entry means, and what the screen shows while the
 * answer is in flight are all decided here, where a test can reach them without
 * a DOM.
 *
 * The one rule worth reading twice is the joining rule, and it is the reason
 * the reply carries `directory` at all. At the top of a browse the hub answers
 * `directory: null` and the entries *are* the roots, each carrying its own
 * absolute path; one level down an entry is a single segment to be joined onto
 * the directory that was listed. A picker that guessed between the two would
 * produce `/srv/work//srv/work` on the first click.
 */

/** One step in the breadcrumb: what to show, and what browsing it would ask for. */
export interface BrowseStep {
  readonly label: string;
  /** `null` is the roots, which is where every breadcrumb starts. */
  readonly directory: string | null;
}

/**
 * The absolute path an entry names, given the listing it came from.
 *
 * `null` for an entry that cannot be descended into. A file is not a directory
 * and neither is a symlink -- the server reports one as `other` and will refuse
 * to list it, so the picker does not offer the click rather than offering one
 * that is answered with a sentence.
 */
export function descendTo(listing: DirectoryListingView, entry: DirectoryEntry): string | null {
  if (entry.kind !== 'directory') return null;
  // At the top the entries are the roots themselves, absolute already. There is
  // nothing to join them onto: `directory` is null precisely because there is no
  // parent above a root.
  if (listing.directory === null) return entry.name;
  const parent = listing.directory.endsWith('/')
    ? listing.directory.slice(0, -1)
    : listing.directory;
  return `${parent}/${entry.name}`;
}

/**
 * The path back to the roots, as steps.
 *
 * It stops at the root the directory sits under rather than walking up to `/`,
 * because the server would refuse every step above one and a breadcrumb whose
 * left half is unclickable is a breadcrumb that lies about where you can go.
 * Which root that is comes off the reply, which carries them all, so this never
 * has to assume a shape for somebody else's disk.
 *
 * A directory under no root still gets its root step and its own: the picker is
 * showing what the server answered, and the server only answers for paths it
 * allowed. This is defensive rather than expected, and the direction it fails
 * in is "fewer steps than there could be" rather than an unclickable one.
 */
export function breadcrumb(
  directory: string | null,
  roots: readonly string[],
): readonly BrowseStep[] {
  const steps: BrowseStep[] = [{ label: roots.length === 1 ? 'root' : 'roots', directory: null }];
  if (directory === null) return steps;

  const root = roots.find(
    (candidate) => directory === candidate || directory.startsWith(`${candidate}/`),
  );
  if (root === undefined) return [...steps, { label: directory, directory }];

  steps.push({ label: root, directory: root });
  const rest = directory
    .slice(root.length)
    .split('/')
    .filter((segment) => segment.length > 0);
  let walked = root;
  for (const segment of rest) {
    walked = `${walked}/${segment}`;
    steps.push({ label: segment, directory: walked });
  }
  return steps;
}

/** The frame that asks for one directory on one server. */
export function browseFor(
  server: ServerRegistrationId,
  directory: string | null,
): HubCommand & { readonly type: 'directory-list' } {
  return { type: 'directory-list', server, directory };
}

/**
 * What the picker is looking at right now.
 *
 * Keyed on the id of the browse in flight, so an answer to an earlier click
 * cannot be rendered under a later one. `idle` is the state before anything has
 * been asked; `waiting` is a question with no answer yet; the other two are the
 * hub's answer to this question and nothing else.
 */
export type PickerView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'listing'; readonly listing: DirectoryListingView }
  | { readonly kind: 'refused'; readonly words: string };

export function pickerView(snapshot: HubSnapshot, pending: FrameId | null): PickerView {
  if (pending === null) return { kind: 'idle' };
  if (snapshot.lastListing?.replyTo === pending) {
    return { kind: 'listing', listing: snapshot.lastListing };
  }
  const refusal = snapshot.lastRefusal;
  if (refusal !== null && refusal.replyTo === pending) {
    return { kind: 'refused', words: refusalWords(refusal) };
  }
  return { kind: 'waiting' };
}

/**
 * A refusal as a sentence.
 *
 * The hub's own words, because they are the only ones that know which machine
 * this was and which setting an operator would change -- "this server has no
 * browse roots configured", "/etc is not under a directory this server will
 * browse". What is added is the one thing the message cannot say about itself:
 * whether trying again is worth anything.
 */
export function refusalWords(refusal: RefusalView): string {
  return refusal.code === 'internal'
    ? `${refusal.message}. Trying again may work.`
    : refusal.message;
}

/**
 * The sentence under a truncated listing, or `null` when there is none.
 *
 * Said rather than left to be inferred from a round number of rows, because the
 * failure this prevents is somebody concluding a directory does not hold what
 * they are looking for after being shown a prefix of it.
 */
export function truncationNotice(listing: DirectoryListingView): string | null {
  if (!listing.truncated) return null;
  return (
    `only the first ${String(listing.entries.length)} entries are shown: ` +
    'this directory holds more than one listing carries'
  );
}

/**
 * Whether this directory may be chosen, and why not when it may not.
 *
 * The roots listing is the one place the answer is no. `directory: null` is not
 * a directory -- it is the question "which of these" -- and a picker that let
 * somebody confirm there would hand back a project with no path on it.
 */
export function chooseBlockedReason(view: PickerView): string | null {
  if (view.kind !== 'listing') return 'nothing is listed yet';
  if (view.listing.directory === null) return 'choose one of the directories below';
  return null;
}
