import { resolvePin } from '@agentplex/release';
import type { Component } from '../../installation/components.js';
import type { VersionCheck } from '../../versions/version-check.js';
import type { AskedComponent } from './update-flags.js';

/** One component named on the command line, with the release its pin names. */
export interface ResolvedComponent {
  readonly component: Component;
  /** An exact release, or `null` for whatever the manifest calls current. */
  readonly version: string | null;
}

export type PinResolution =
  | { readonly ok: true; readonly resolved: readonly ResolvedComponent[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Every pin on the command line, turned into the release it names, before
 * anything is stopped.
 *
 * The rule is `packages/release`'s `resolvePin`, which is `install.sh`'s: an
 * exact pin is taken as it is, and a series is the newest release the manifest
 * lists under it. This is the part that knows where the manifest came from, so
 * a refusal can name it.
 *
 * A series with no manifest to resolve against, or with nothing in it, stops
 * the run naming the component and the series, where `install.sh` stops too. An
 * exact pin needs no manifest to be an answer -- it names the tag outright --
 * so it passes through either way, and whether the manifest lists it stays a
 * question about its protocol for the plan to ask.
 */
export function resolvePins(
  asked: readonly AskedComponent[],
  checked: VersionCheck,
): PinResolution {
  const problems: string[] = [];
  const resolved: ResolvedComponent[] = [];

  for (const { component, pin } of asked) {
    if (pin === null || pin.kind === 'exact') {
      resolved.push({ component, version: pin?.version ?? null });
      continue;
    }

    const named = `${component}@${pin.series}`;
    if (!checked.ok) {
      problems.push(
        `${named} names a series, and resolving one needs the release manifest, which could ` +
          `not be read from ${checked.source}: ${checked.problem}`,
      );
      continue;
    }

    const version = resolvePin(pin, checked.manifest[component]);
    if (version === null) {
      problems.push(
        `${checked.source} offers no ${component} release under ${pin.series}, so ${named} ` +
          'names a series it advertises nothing in. A series takes the newest release under ' +
          'it and never a prerelease; a prerelease named exactly is installed',
      );
      continue;
    }
    resolved.push({ component, version });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, resolved };
}
