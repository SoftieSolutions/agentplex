import type { HubId, Layout, PushEndpoint, PushSubscription } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { Approvals } from '../approvals/approvals.js';
import type { ApprovalPolicy } from '../approval-policy/approval-policy.js';
import type { Attention } from '../attention/attention.js';
import type { CatalogueQueries, TreeMutations } from '../catalogue/catalogue.js';
import type { Docs } from '../docs/docs.js';
import type { GraphRuns } from '../graph-runs/graph-runs.js';
import type { Graphs } from '../graphs/graphs.js';
import type { Pairing } from '../pairing/pairing.js';
import type { Projects } from '../projects/projects.js';
import type { Sessions } from '../sessions/sessions.js';
import type { Terminal } from '../terminal/terminal.js';

/**
 * A machine-state frame, encoded once for everybody, with the version it
 * carries kept alongside so a connection can tell whether it already has it.
 */
export interface EncodedMachineState {
  readonly version: number;
  /** The output of `encodeHubFrame` on a `machine-state` frame. */
  readonly text: string;
}

/**
 * What a client socket may do about web push, and no more than that.
 *
 * Three functions rather than the push feature itself, and the missing fourth
 * is the reason: `notify` is the fan-out, it is driven by an edge detector
 * watching the fleet state, and a connection that could reach it would be a
 * socket able to make every subscribed browser buzz. Nothing here can send a
 * notification; what a client may do is say whether it wants them.
 *
 * `publicKey` is a function and not a value because it is read at the moment a
 * welcome is written. The pair is minted at boot, before the first socket, but
 * a value captured at wiring time would be one more thing whose freshness
 * depends on the order two lines ran in.
 *
 * The push feature satisfies this structurally, which is what keeps this file
 * free of any import from it: what crosses is the protocol's own types.
 */
export interface ClientPush {
  publicKey(): string | null;
  subscribe(subscription: PushSubscription): Promise<void>;
  unsubscribe(endpoint: PushEndpoint): Promise<void>;
}

export interface ClientConnectionDependencies {
  readonly hubId: HubId;
  readonly logger: Logger;
  /**
   * The state as it is right now, encoded. Read at the moment this client
   * becomes established, so that a client that arrives during a quiet hour is
   * not looking at an empty screen until something happens to change.
   */
  readonly currentState: () => EncodedMachineState;
  /**
   * The stored layout, read when a client asks for one.
   *
   * A function rather than a value, and read per request rather than cached
   * beside the state: the layout changes when the user rearranges their tree,
   * not when a server reports, so it has neither the machine state's version
   * nor its schedule. Encoding it once for everybody would be wrong anyway --
   * this is the one thing the hub sends that is not the same for every client.
   */
  readonly readLayout: () => Promise<Layout>;
  /**
   * The stored pane layout: characters the hub keeps and never parses.
   *
   * Two functions and no cache, for the reason `readLayout` gives. What is
   * different here is what the hub knows about the value: nothing. The split
   * arrangement's shape rules live in the web client, and the hub's promise is
   * to answer back exactly the characters the last save carried — so a new
   * pane type is a client release, never a service one.
   */
  readonly readPaneLayout: () => Promise<string | null>;
  readonly writePaneLayout: (layout: string) => Promise<void>;
  /**
   * Starting and stopping sessions.
   *
   * A seam rather than a reducer and a supervisor reached directly, because
   * what a client may ask for is one decision and this file is not where it
   * lives: the routing sees the whole fleet, and a connection sees one socket.
   */
  readonly sessions: Sessions;
  /**
   * What the user has said about a session: acknowledged, muted, unmuted.
   *
   * A seam beside the sessions one rather than a pair of methods on it,
   * because they are opposite kinds of act. A start or a stop crosses to a
   * machine and is refused by whatever that machine says; these write a row in
   * this hub's own database, reach no machine at all, and are refused by one
   * rule -- that the hub can see the session being talked about.
   *
   * What a client cannot reach through it is the reading: there is no "tell me
   * the attention of this session" frame, because the answer is already on
   * every session row of the state this connection is sent unasked.
   */
  readonly attention: Attention;
  /**
   * The requests the hub is holding open, as the one thing that may answer one.
   *
   * A seam beside the attention one and not a method on it, because the two
   * are opposite in the way that matters here: an acknowledgement is this
   * hub's own row and reaches no machine, and a decision travels to the box
   * holding a blocked process and is applied exactly once for every client
   * watching. What this connection may not do is decide anything itself -- it
   * hands the request over and says what came back.
   */
  readonly approvals: Approvals;
  /**
   * The standing policy, as the feature that owns those rows.
   *
   * Beside `approvals` and not inside it, because the two are opposite in the
   * way that matters: a request is a claim about now, held in memory on the
   * machine that is holding a process open, and a rule is a thing a person
   * decided on purpose and wrote down. What this connection may do with it is
   * read one project's rules, add one, and take one out -- every refusal, and
   * every sentence explaining one, is the feature's.
   */
  readonly approvalPolicy: ApprovalPolicy;
  /**
   * Which servers this hub may dial, as the feature that owns those rows.
   *
   * The whole seam rather than two functions, because what a pairing frame
   * does is exactly what this interface says: record a pairing, or revoke one.
   * The rules about what a pairing may be -- the address parser, the label
   * bound -- are its to state, and a connection that took a pre-checked value
   * would be a second place those rules were decided.
   */
  readonly pairing: Pairing;
  /**
   * Tells the servers feature that the pairing table has changed.
   *
   * A function and not the `Servers` seam: what a connection needs is for a
   * new pairing to be dialled and a revoked one to stop, and handing a socket
   * the supervisor would also hand it `stop()`. The supervisor reads the table
   * itself -- this says only that there is something to re-read.
   */
  readonly syncServers: () => Promise<void>;
  /**
   * Projects: the rows a client makes and renames, and the browse a directory
   * is picked with.
   *
   * A seam beside the sessions one and not folded into it, because they answer
   * different questions: which machine runs this, and which directory is this.
   * The rule about what a client may see lives further down still -- on the
   * server, over roots its own operator configured -- and nothing on this file's
   * path can widen it.
   */
  readonly projects: Projects;
  /**
   * The five edits a client may make to the tree, and the query it reads part
   * of the tree with.
   *
   * Narrower than the catalogue, and deliberately not the same seam the whole
   * layout arrives on: `readLayout` above is one function answering one frame,
   * and these are the acts the feature that owns the rows decides. What this
   * file does with all of them is the same -- answer the client that asked,
   * and nobody else.
   */
  readonly catalogue: TreeMutations & CatalogueQueries;
  /**
   * Documents: the index, and the one path a write to one takes.
   *
   * A seam beside projects rather than a method on it, because they own
   * different rows and answer different questions -- which directory is this,
   * and what is in it. What matters more here is what this file may not do: it
   * calls the four functions and reaches no server, so the MCP tools of
   * AGX-244 calling the same four are the same write path and not a second one.
   */
  readonly docs: Docs;
  /**
   * Graphs: the hub's own rows, and the four things a client may do to one.
   *
   * A seam beside documents rather than a method on them, because the two
   * are opposite in the way that matters here: a document is an index of a
   * file on a machine, and a graph is content the hub holds. What this file
   * does with both is the same -- answer the client that asked, and nobody
   * else -- and it reaches no row and no rule of either directly.
   */
  readonly graphs: Graphs;
  /**
   * Runs: start one, cancel one. The states come back the other way, through
   * `graphRunState` on the connection, because a run moves on its own clock
   * and not in answer to a frame.
   */
  readonly graphRuns: GraphRuns;
  /**
   * The terminal relay, which this connection is one end of.
   *
   * A seam rather than a set of subscriptions held here, because a subscription
   * is not a property of a socket: one terminal may be watched by two of them,
   * the bytes cross the server leg once, and the thing that decides which
   * sockets a chunk reaches has to see all of them. What this file owns is the
   * other half of that -- handing the relay a frame, and telling it when this
   * socket goes away.
   */
  readonly terminal: Terminal;
  /**
   * Web push, or `null` for a hub that has none.
   *
   * `null` is not a degraded hub: it is one served over plaintext, or one whose
   * composition root gave it no way to sign and send. Such a hub says so on the
   * welcome and refuses the two frames in words, rather than accepting a
   * subscription it can never push to -- which would be a browser waiting for
   * notifications that were never going to come, with nothing anywhere saying
   * why.
   */
  readonly push: ClientPush | null;
  /** Called once when this connection ends, so the broadcast can forget it. */
  readonly onClosed?: () => void;
}
