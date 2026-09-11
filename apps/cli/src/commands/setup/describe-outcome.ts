import type { ProviderReport, ServerSetupOutcome, SetupOutcome } from './apply-setup-plan.js';

/**
 * A run as lines a person reads.
 *
 * Its own module because both front ends end in it. `setup --plan` prints it to
 * a boot log and the wizard prints it to the operator who just answered the
 * questions, and a machine provisioned two ways has to be describable one way —
 * otherwise the unattended report and the interactive one drift, and the
 * difference between them reads as a difference between the machines.
 *
 * Facts and no advice: what role this machine is, what it will resolve programs
 * in, which providers are there and whether they are logged in. The pairing
 * token is named by its location and never printed — a terminal is a scrollback
 * and, on a cloud instance, the boot log.
 */
export function describeOutcome(outcome: SetupOutcome): readonly string[] {
  const lines = [`role: ${outcome.role}`];
  if (outcome.hub !== null) lines.push(`hub: port ${outcome.hub.port}`);
  if (outcome.server !== null) lines.push(...describeServer(outcome.server));
  return lines;
}

function describeServer(server: ServerSetupOutcome): readonly string[] {
  const lines = [
    `server: port ${server.port}`,
    `bin path: ${server.binPath.join(', ')}`,
    `identity: ${server.identity.path}${
      server.identity.serverId === null ? '' : ` (server ${server.identity.serverId})`
    }${server.identity.minted ? ' - minted; the pairing token is in that file' : ''}`,
  ];

  for (const store of server.stores) {
    lines.push(
      store.ok
        ? `store: ${store.store.path} (store ${store.store.storeId})${store.minted ? ' - minted' : ''}`
        : `store: ${store.path} - unusable`,
    );
  }

  for (const provider of server.providers) lines.push(describeProvider(provider));

  return lines;
}

function describeProvider(provider: ProviderReport): string {
  const state =
    provider.authState === null
      ? 'login state unknown'
      : provider.authState === 'authenticated'
        ? 'logged in'
        : 'not logged in';

  if (provider.action === 'none') {
    // What is on the machine, when there is something, so that "the pinned
    // version could not be installed" does not read as "there is no provider".
    // Why it could not be is one of the problem lines on stderr.
    const present = provider.version === null ? '' : ` (${provider.version} is what is there)`;
    return `provider: ${provider.provider} - not provisioned${present}`;
  }

  return `provider: ${provider.provider} ${provider.version ?? 'version unknown'} - ${provider.action}, ${state}`;
}
