import { z } from 'zod';

/**
 * One page's name for itself, said on every hello it sends.
 *
 * A start handle is the frame id of the `session-start` that asked, and a
 * frame id is unique only within what minted it. The web mints its frame ids
 * once per store, so a handle stays unique across every socket that store
 * opens -- but the hub keyed its handles by socket, and a socket is exactly
 * what a redial replaces. A spawn the provider named while the page was
 * between sockets was named to nobody, and the pane that asked for it went on
 * saying "starting" until the bound gave up on it. The instance is the name
 * that outlives the socket: the hub files a start under the instance that
 * asked, and a page that says hello again under the same instance is told
 * what its spawns became.
 *
 * Sixteen random bytes as lowercase hex, minted once per store. Random rather
 * than counted, because two tabs on one hub are two pages and a counter in
 * each would make them one: the second would take over the first's starts.
 * Sixteen bytes so that two pages colliding is not a case anybody has to
 * handle. The shape is exact, because a word read off the network is a claim
 * and a parser that accepted anything would let a page name itself in a form
 * no page mints.
 *
 * It is not a credential and never gates anything. One token is one principal,
 * and every page holding it may already do everything another may; an
 * instance only says which of them asked, so the hub can route a reply that
 * outlived its socket. That is also why it is never logged whole: it is the
 * key a redial is matched on, and a log line is not where it belongs.
 */
export const clientInstanceSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .brand<'ClientInstance'>();
export type ClientInstance = z.infer<typeof clientInstanceSchema>;
