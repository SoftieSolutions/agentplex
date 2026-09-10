import { providerSchema, type Provider } from '@agentplex/protocol';
import type { ProviderAdapter } from './provider-adapter.js';

/**
 * The one place a provider name becomes an adapter.
 *
 * A name is a claim — off a frame, off a database row, off a file somebody
 * edited — so it is parsed, never cast, and the answer to a name nobody
 * implements is a refusal rather than an `undefined` that surfaces three calls
 * later as a crash. Registering is the only way an adapter becomes reachable,
 * which is what makes "add a provider" one file and one line of wiring.
 */
export interface ProviderRegistry {
  /** The providers this build can actually drive, in registration order. */
  readonly providers: readonly Provider[];
  /** The adapters themselves, for callers that ask every provider in turn. */
  readonly adapters: readonly ProviderAdapter[];
  lookup(name: unknown): ProviderLookup;
}

/**
 * Why a lookup failed, as a value.
 *
 * The two failures are genuinely different and callers act differently on
 * them: an unknown name is a bad request from whoever sent it, while a known
 * provider with no adapter is this build's own limit and the honest thing to
 * tell a user about a session it can see but cannot drive. Telling them apart
 * by matching on the message is exactly what a `reason` exists to prevent.
 */
export type ProviderLookup =
  | { readonly ok: true; readonly adapter: ProviderAdapter }
  | {
      readonly ok: false;
      readonly reason: 'unknown-provider' | 'no-adapter';
      readonly problem: string;
    };

/**
 * Throws on a duplicate, and only on a duplicate.
 *
 * Two adapters claiming one provider is a wiring mistake in this repository's
 * own code, not a claim from outside it: there is no user input that can cause
 * it and no degraded answer that is better than stopping. Silently keeping the
 * last one would run an adapter nobody chose.
 */
export function createProviderRegistry(adapters: readonly ProviderAdapter[]): ProviderRegistry {
  const byProvider = new Map<Provider, ProviderAdapter>();
  for (const adapter of adapters) {
    if (byProvider.has(adapter.provider)) {
      throw new Error(`two adapters are registered for provider ${adapter.provider}`);
    }
    byProvider.set(adapter.provider, adapter);
  }

  const registered = [...byProvider.keys()];

  return {
    providers: registered,
    adapters: [...byProvider.values()],

    lookup(name: unknown): ProviderLookup {
      const parsed = providerSchema.safeParse(name);
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'unknown-provider',
          problem: `${describe(name)} is not a provider agentplex knows`,
        };
      }

      const adapter = byProvider.get(parsed.data);
      if (adapter === undefined) {
        return {
          ok: false,
          reason: 'no-adapter',
          problem: `this build has no adapter for provider ${parsed.data}`,
        };
      }

      return { ok: true, adapter };
    },
  };
}

/** Names the rejected value without pasting an arbitrary payload into a message. */
function describe(name: unknown): string {
  return typeof name === 'string' ? JSON.stringify(name) : `a value of type ${typeof name}`;
}
