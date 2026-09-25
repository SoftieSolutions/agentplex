import type { GraphNode, ServerRegistrationId } from '@agentplex/protocol';
import { countsTowardAttention } from '../servers/servers.js';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import { nameOf } from './walker.js';

/**
 * Where a node's work lands, as far as this feature decides it.
 *
 * ## Cheapest is not a scheduler here
 *
 * A node placed `cheapest` answers `server: null`, and the start that follows
 * goes through `Sessions.start` with no override -- which is `routeStart`
 * picking the machine with the fewest live agents among the servers that have
 * the node's store mounted, are connected, can run the provider and are not
 * draining. That is the hub's one scheduler, and it is what every start from
 * a client already goes through. A second one here, sorting on some notion of
 * cheap, would be two answers to "where does work go" free to drift apart;
 * and the hub holds no load figure to sort on in any case. What "cheapest"
 * means on this hub is "the least busy machine that can", and that is
 * `routeStart`'s definition.
 *
 * ## Pin is checked here, before anything is asked
 *
 * A pinned machine that is not connected is refused here in words, naming the
 * node and the machine, rather than sent to `routeStart` to be refused there.
 * The two would say nearly the same thing; the difference is that this
 * sentence names the node, which is what a person reading a failed run needs
 * -- "Rust reviewer is pinned to gpu-box" is a thing to go and fix, and "the
 * hub cannot reach gpu-box" is not obviously about the graph at all. The
 * refusal is the step's failure, so the node's own retry policy applies to it:
 * a machine asleep for thirty seconds is exactly what a backoff is for.
 */

export type Placement =
  | { readonly ok: true; readonly server: ServerRegistrationId | null }
  | { readonly ok: false; readonly problem: string };

export function placeNode(state: HubStateSnapshot, node: GraphNode): Placement {
  const placement = node.placement;
  if (placement.kind === 'cheapest') return { ok: true, server: null };

  const pinned = state.servers.find((server) => server.registrationId === placement.server);
  if (pinned === undefined) {
    return {
      ok: false,
      problem: `${nameOf(node)} is pinned to a server this hub is not paired with`,
    };
  }
  if (!countsTowardAttention(pinned)) {
    return {
      ok: false,
      problem: `${nameOf(node)} is pinned to ${pinned.label}, which is not connected right now`,
    };
  }
  return { ok: true, server: pinned.registrationId };
}
