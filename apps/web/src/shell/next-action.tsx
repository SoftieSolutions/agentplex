import type { JSX } from 'react';
import { Anchor } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The thing that resolves an empty or degraded state, as one address.
 *
 * Every state in AGX-119 was honest and terminal: it said what was wrong and
 * stopped. What was missing from each was not more words, it was somewhere to
 * go -- so this is deliberately the smallest shape that can be one, a label and
 * an address, and never a callback. Three reasons it is an address:
 *
 *   * the destinations are already addresses (`destinations.ts`), so an empty
 *     state points at the same Settings the nav points at rather than at a
 *     screen only it knows how to open;
 *   * a pure model can name one. `connection-model.ts` and
 *     `session-list-model.ts` decide which action a state carries, and neither
 *     can hold a handler without becoming the component it is factored out of;
 *   * it is a link, so it is middle-clickable, focusable and readable by
 *     anything that lists a page's links -- which a button that navigates is
 *     not.
 *
 * A state whose resolution is not a destination -- the pairing form on the
 * screen you are already on, the New session button above the list -- carries
 * no action and names the control in its words instead. Pointing a link at the
 * screen it is already on would be a route to nowhere.
 */
export interface NextAction {
  /** What the link says. Names the thing that resolves the state. */
  readonly label: string;
  /** Where it goes: a `destinations.ts` hash, never a URL built here. */
  readonly hash: string;
}

export interface NextActionLinkProps {
  readonly action: NextAction;
  readonly scheme: Scheme;
}

/** One action, drawn. The size is the surrounding copy's; only the hue is ours. */
export function NextActionLink({ action, scheme }: NextActionLinkProps): JSX.Element {
  return (
    <Anchor href={action.hash} c={colorForRole('link', scheme)}>
      {action.label}
    </Anchor>
  );
}
