import { z } from 'zod';

const opaqueId = z.string().min(1).max(200);

/** Minted into `agentplex-store.json` at a store root and stable thereafter. */
export const storeIdSchema = opaqueId.brand<'StoreId'>();
export type StoreId = z.infer<typeof storeIdSchema>;

/** The provider's own id for a session. Unique only within its store. */
export const sessionIdSchema = opaqueId.brand<'SessionId'>();
export type SessionId = z.infer<typeof sessionIdSchema>;

/** Identifies one paired server process, across restarts and address changes. */
export const serverIdSchema = opaqueId.brand<'ServerId'>();
export type ServerId = z.infer<typeof serverIdSchema>;

/**
 * The hub's own name for a pairing. Distinct from `ServerId`, which is what
 * the server calls itself: this one exists from the moment the user submits
 * the form, and the other only after a handshake has confirmed it.
 *
 * It lives here rather than beside the pairing table because it is on the wire:
 * the machine-state frame keys every server on it, and a store names its
 * attached servers by it. A client needs a stable key for a row, and `ServerId`
 * cannot be one while it is still `null` for a pairing that has never answered.
 */
export const serverRegistrationIdSchema = opaqueId.brand<'ServerRegistrationId'>();
export type ServerRegistrationId = z.infer<typeof serverRegistrationIdSchema>;

/** Identifies the hub to clients; distinguishes two hubs to one paired server. */
export const hubIdSchema = opaqueId.brand<'HubId'>();
export type HubId = z.infer<typeof hubIdSchema>;

/** One node in the user's tree. Minted by the hub, stable across renames and moves. */
export const nodeIdSchema = opaqueId.brand<'NodeId'>();
export type NodeId = z.infer<typeof nodeIdSchema>;

/**
 * What a node is, as an open string rather than an enum.
 *
 * This is the wire half of kind-as-foreign-key. A new kind is a row in the
 * hub's `node_kinds` table, and if this were `z.enum([...])` it would also be a
 * protocol change and a client release — which is the schema rewrite the design
 * spent a lookup table to avoid, moved onto the wire. A client that meets a
 * kind it does not know renders it as an ordinary node rather than failing to
 * parse the layout: the tree is still the user's tree, and refusing the whole
 * of it because one row is newer than the client would be the over-claim.
 */
export const nodeKindSchema = opaqueId.brand<'NodeKind'>();
export type NodeKind = z.infer<typeof nodeKindSchema>;

/**
 * A session's identity is its store and its id within it — never the machine.
 *
 * Which server happens to be running a session is a live fact the hub tracks
 * and a session may move; a session that is identified by where it ran cannot.
 */
export const sessionRefSchema = z.object({
  storeId: storeIdSchema,
  sessionId: sessionIdSchema,
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

/**
 * The coding-agent CLI behind a session.
 *
 * v2 ships the Claude Code adapter only. The other names are listed because
 * the field is on the wire from day one: a hub that meets a session it cannot
 * drive should still be able to say what it is.
 */
export const providerSchema = z.enum(['claude', 'codex', 'opencode']);
export type Provider = z.infer<typeof providerSchema>;

/** A store as reported by a server that has it mounted. */
export const storeDescriptorSchema = z.object({
  storeId: storeIdSchema,
  /** The store's path on that server. Shown to the user; never sent back as an argument. */
  path: z.string().min(1),
});
export type StoreDescriptor = z.infer<typeof storeDescriptorSchema>;
