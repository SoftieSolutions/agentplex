import { z } from 'zod';
import type { AuthState, InstalledProvider, ProviderProvisioning } from '../provider-adapter.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { OperationRefusal } from './operation.js';
import type { SetupOperation } from './setup-operation.js';

/**
 * The three provisioning spawns, as operations.
 *
 * They are one family and one file because they share the only thing about them
 * that is not the adapter's business: a request names a provider, and the answer
 * to a provider name is looked up in exactly one place. Everything else — the
 * installer, the flags, what its output means — belongs to the adapter and is
 * not repeated here. That is what makes a second provider a new adapter rather
 * than a fourth branch in this file.
 *
 * There is no `provider.login`. `ProviderProvisioning.login` returns a `Launch`,
 * which is a pty and not a one-shot child, so there is no shape in which it
 * could be registered here even if somebody wanted it: it goes to the same
 * supervisor a session goes to. The omission is structural rather than a
 * decision anybody has to keep making.
 *
 * None of the three is on the wire-facing registry, and that is the point of the
 * ticket rather than an accident of where the file sits. See
 * `setup-operation-registry.ts`.
 */

/**
 * A provider name, checked by the thing that has to turn it into an adapter.
 *
 * `z.string()` and not `providerSchema`, deliberately. The registry is "the one
 * place a provider name becomes an adapter", it already parses the name and it
 * already tells the two failures apart — a word that is not a provider, and a
 * provider this build has no adapter for. Parsing it here as well would make one
 * of those unreachable, which is how a refusal branch nobody can test gets
 * written and then quietly gets wrong.
 */
const providerNameSchema = z.string().min(1);

const providerRequestSchema = z.strictObject({ provider: providerNameSchema });
export type ProviderProvisioningRequest = z.infer<typeof providerRequestSchema>;

/**
 * Note what the prefix is *not* checked against here: whether it is absolute,
 * whether it has a NUL in it, whether it is a directory an installer can write
 * into. Those are the installer's rules, they differ per provider, and
 * `parsePrefix` in the Claude adapter is where one of them lives. A copy here
 * would be the same policy in two places, drifting apart in the direction where
 * one of them is laxer.
 */
export const providerInstallRequestSchema = z.strictObject({
  provider: providerNameSchema,
  prefix: z.string().min(1),
  /** A pinned version, or `null` for whatever the provider calls current. */
  version: z.string().min(1).nullable(),
});
export type ProviderInstallRequest = z.infer<typeof providerInstallRequestSchema>;

export const providerInstallOperation: SetupOperation<ProviderInstallRequest, InstalledProvider> = {
  name: 'provider.install',
  summary: 'Install a provider into a prefix agentplex owns',
  request: providerInstallRequestSchema,

  plan: (request, providers) => {
    const found = provisioningFor(request.provider, providers);
    if (!found.ok) return found;

    const install = found.provisioning.install({
      prefix: request.prefix,
      version: request.version,
    });
    if (!install.ok) {
      // The adapter looked at the request and said no. That is the request
      // being wrong and not the machine being unable, so it is the same
      // refusal an unparseable request gets — and, like that one, nothing has
      // been started by the time it is returned.
      return { ok: false, refusal: 'invalid-request', problem: install.problem };
    }

    return { ok: true, plan: install.plan };
  },
};

export const providerVersionOperation: SetupOperation<ProviderProvisioningRequest, string> = {
  name: 'provider.version',
  summary: 'Ask an installed provider which version it is',
  request: providerRequestSchema,

  plan: (request, providers) => {
    const found = provisioningFor(request.provider, providers);
    return found.ok ? { ok: true, plan: found.provisioning.version() } : found;
  },
};

export const providerAuthStateOperation: SetupOperation<ProviderProvisioningRequest, AuthState> = {
  name: 'provider.auth-state',
  summary: 'Ask an installed provider whether it is logged in',
  request: providerRequestSchema,

  plan: (request, providers) => {
    const found = provisioningFor(request.provider, providers);
    return found.ok ? { ok: true, plan: found.provisioning.authState() } : found;
  },
};

/**
 * The provider name, resolved to the thing that knows how to provision it.
 *
 * The two lookup failures keep their difference all the way out. A name that is
 * not a provider is the caller asking for something ill-formed; a provider with
 * no adapter in this build is this build's own limit, which is the same kind of
 * fact as a program that is not installed. Collapsing them would leave an
 * operator reading "invalid request" about a perfectly valid one.
 */
function provisioningFor(
  provider: string,
  providers: ProviderRegistry,
):
  | { ok: true; provisioning: ProviderProvisioning }
  | { ok: false; refusal: OperationRefusal; problem: string } {
  const found = providers.lookup(provider);
  if (found.ok) return { ok: true, provisioning: found.adapter.provisioning };

  return {
    ok: false,
    refusal: found.reason === 'unknown-provider' ? 'invalid-request' : 'unavailable',
    problem: found.problem,
  };
}
