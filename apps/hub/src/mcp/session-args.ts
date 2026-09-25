import {
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionRef,
  type StoreId,
} from '@agentplex/protocol';
import type { SessionRefused } from '../sessions/sessions.js';
import { refuses, type McpAnswer } from './tool-registry.js';

/**
 * The two things every session tool does with words: turn what a model typed
 * into the ids a feature takes, and turn a feature's no back into a sentence.
 *
 * Both are here rather than in each tool because there are four tools now and
 * the wording is the contract. A store id spelled wrong is refused in the same
 * sentence whichever tool was called, and a refusal that names a holder names
 * it the same way -- which is what lets an agent branch on the answer instead
 * of matching four phrasings of one fact.
 *
 * ## Why a parse and not a cast
 *
 * These arrive as strings off an MCP client, and every feature below addresses
 * a store, a session and a machine by a branded id. A cast here would be this
 * endpoint deciding that whatever a model typed is an id -- which is the one
 * decision `parse, never cast` exists to stop, and the tools are exactly the
 * place a string arrives from outside.
 *
 * `safeParse`, so that a string that is not an id is refused the way everything
 * else here is refused: in words. A throw would be caught by the SDK and
 * answered as a failed call either way, but with zod's words in it rather than
 * a hub's.
 */

/**
 * What a bad id is refused with.
 *
 * One sentence covering both halves, because either one of them can be the
 * wrong half and a caller told only "bad id" has two things to check. The
 * bound is the protocol's own: every id in `identity.ts` is one to two hundred
 * characters.
 */
const NOT_A_SESSION = 'a store id and a session id are each one to two hundred characters';

/** A session's identity, as the features address one: a store and an id in it. */
export function parsedSessionRef(storeId: string, sessionId: string): McpAnswer<SessionRef> {
  const store = storeIdSchema.safeParse(storeId);
  const session = sessionIdSchema.safeParse(sessionId);
  if (!store.success || !session.success) return refuses(NOT_A_SESSION);
  return { ok: true, value: { storeId: store.data, sessionId: session.data } };
}

/** A store on its own, which is all a start names. */
export function parsedStoreId(storeId: string): McpAnswer<StoreId> {
  const store = storeIdSchema.safeParse(storeId);
  if (!store.success) return refuses('a store id is one to two hundred characters');
  return { ok: true, value: store.data };
}

/** A machine, as `list_servers` names one. */
export function parsedServerId(server: string): McpAnswer<ServerRegistrationId> {
  const parsed = serverRegistrationIdSchema.safeParse(server);
  if (!parsed.success) {
    return refuses('a server registration id is one to two hundred characters');
  }
  return { ok: true, value: parsed.data };
}

/**
 * A start or a stop that did not happen, as an agent reads it.
 *
 * The feature's own sentence, and the holder's registration id appended when
 * the refusal carries one. Appended rather than left off, because the sentence
 * and the id are two different things: the sentence names a machine the way a
 * person reads it, by the label somebody typed when they paired it, and an
 * agent's next call needs the id `list_servers` keys on.
 *
 * It goes in the words rather than beside them, and that is forced rather than
 * chosen. A refusal is `isError: true` and carries no structured result -- the
 * registry says why -- and an MCP client validates any structured value it is
 * handed against the output schema the tool published, so a refusal shaped like
 * a holder would be a failed call in every client that checks. The sentence is
 * the whole channel, so everything an agent can act on is in it.
 */
export function refusedSession(outcome: SessionRefused): McpAnswer<never> {
  if (outcome.holder === null) return refuses(outcome.problem);
  return refuses(`${outcome.problem}; it is held by ${outcome.holder.server}`);
}
