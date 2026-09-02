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

/** Identifies the hub to clients; distinguishes two hubs to one paired server. */
export const hubIdSchema = opaqueId.brand<'HubId'>();
export type HubId = z.infer<typeof hubIdSchema>;

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
