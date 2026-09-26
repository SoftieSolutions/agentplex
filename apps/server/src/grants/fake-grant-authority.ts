import { tokenMatches } from '@agentplex/node-shared';
import type { HubId } from '@agentplex/protocol';
import type { AuthorizedGrant, GrantAuthority } from './server-grant-store.js';
import type { GrantId, GrantRefusal } from './server-grants.js';

export interface FakeGrantAuthorityOptions {
  /**
   * The tokens this authority accepts, each with the grant it resolves to. A
   * test that only cares that a good token works passes one entry.
   */
  readonly grants?: Readonly<Record<string, string>>;
  /** Grants whose next authorization refuses, by the reason it refuses with. */
  readonly withdrawn?: Readonly<Record<string, GrantRefusal>>;
}

export interface FakeGrantAuthority extends GrantAuthority {
  /** Every handshake this authority was asked about, in order. */
  readonly seen: readonly { readonly token: string; readonly hubId: HubId }[];
  /** Withdraws a grant, so a test can revoke one under a live connection. */
  withdraw(grantId: string, refusal?: GrantRefusal): void;
}

/**
 * A grant authority with the file taken out of it.
 *
 * It holds the one property every caller depends on -- a token resolves to a
 * grant id, and a refusal says nothing a frame may repeat -- so a test of a
 * connection asserts on what the connection does with a decision rather than on
 * how a decision is stored. The store's own rules are tested against a fake
 * disk in `server-grant-store.test.ts`, which is where they belong.
 */
export function createFakeGrantAuthority(
  options: FakeGrantAuthorityOptions = {},
): FakeGrantAuthority {
  const grants = new Map(Object.entries(options.grants ?? {}));
  const withdrawn = new Map<string, GrantRefusal>(Object.entries(options.withdrawn ?? {}));
  const seen: { readonly token: string; readonly hubId: HubId }[] = [];

  return {
    get seen(): readonly { readonly token: string; readonly hubId: HubId }[] {
      return seen;
    },

    withdraw(grantId: string, refusal: GrantRefusal = 'revoked'): void {
      withdrawn.set(grantId, refusal);
    },

    authorize({ token, hubId }): Promise<AuthorizedGrant> {
      seen.push({ token, hubId });
      for (const [accepted, grantId] of grants) {
        // The same comparison the real one uses, so a test cannot pass by
        // accident on a spelling the server would have refused.
        if (!tokenMatches(token, accepted)) continue;
        const refusal = withdrawn.get(grantId);
        if (refusal !== undefined) return Promise.resolve({ ok: false, refusal });
        return Promise.resolve({
          ok: true,
          grantId: grantId as GrantId,
          label: `the grant for ${grantId}`,
        });
      }
      return Promise.resolve({ ok: false, refusal: 'no-grant' });
    },
  };
}
