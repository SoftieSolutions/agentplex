import { wantsAttention, type SessionListItem } from './session-list-model.js';

/**
 * The attention floor: the one number every ambient surface speaks from, and
 * the words the browser tab says it in.
 *
 * "Floor" because it sits under the screens rather than on one -- the bell in
 * the chrome, the document title, and later the push are three ways of saying
 * the same sentence, and they say it from here so they cannot come to three
 * different answers while looking at one fleet.
 */

/**
 * How many sessions are asking for a human right now.
 *
 * `wantsAttention` and nothing else, so this number is `needsYou` minus the
 * three things that make a prompt stop asking: it has been acknowledged, it
 * has been muted, or the machine holding it cannot be reached and so nothing a
 * person does about it would land. The list keeps drawing all of those -- the
 * fact does not disappear because the noise stopped -- which is exactly why
 * the badge count and the list's own needs-you count are different functions.
 *
 * A finished run never counts: a completion is not a question. Diluting the
 * title with "something happened" makes the case where something is genuinely
 * blocked indistinguishable from the case where it is not, and a title people
 * have learned to ignore buys nothing at all.
 *
 * It counts the items it is handed and narrows nothing itself. Whether the
 * bell speaks for the whole fleet or only for the machine somebody is looking
 * at is a question about that surface, answered where the items are chosen.
 */
export function attentionFloorCount(items: readonly SessionListItem[]): number {
  return items.filter(wantsAttention).length;
}

/** The product name, as `index.html` ships it, and the title's resting state. */
const BARE_TITLE = 'agentplex';

/**
 * The document title for a given count: `agentplex`, or `(2) agentplex`.
 *
 * The count leads, because a title is read in a strip of tabs where everything
 * past the first few characters is cut off, and the parenthesised number is
 * the form every mail and chat client has already taught people to read.
 */
export function titleFor(count: number): string {
  return count === 0 ? BARE_TITLE : `(${count}) ${BARE_TITLE}`;
}
