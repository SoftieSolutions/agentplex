/**
 * Where the hub credential is read from, as one module both sides agree on.
 *
 * The session list (AGX-32) constructs the store and needs a token to hand the
 * ticket exchange; the settings screen (AGX-35) is what will let the user type
 * one in. This file is the seam between them: reading lives here now, writing
 * lands here later, and neither ticket has to know how the other stores it.
 */

export const HUB_TOKEN_STORAGE_KEY = 'agentplex.hub-token';

/**
 * The stored credential, or `null` when there is none to read.
 *
 * The guard wraps the access itself, not just the lookup: in a private window
 * or under a blocked-storage policy, touching `localStorage` throws before any
 * key is asked for. No token is a state the connection machinery already says
 * in words -- the ticket exchange answers 401 and the snapshot carries the
 * sentence -- so `null` here never needs to become an error here.
 */
export function readHubToken(): string | null {
  try {
    return window.localStorage.getItem(HUB_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}
