import {
  updateVersionsManifest,
  type ReleaseProtocol,
  type VersionsManifest,
} from '@agentplex/release';
import { SERIES_RESOLUTION_CASES } from '@agentplex/release/testing';
import { describe, expect, it } from 'vitest';
import { systemLayout, userLayout, type Layout } from '../../installation/layout.js';
import { readInstallFlags, type InstallRequest } from './install-flags.js';
import {
  formatPlanLine,
  planInstall,
  unitSkipReason,
  type InstallPlanInput,
  type PlanLine,
  type ReleaseInput,
} from './install-plan.js';

/**
 * The plan `agentplex install --dry-run` prints, in `install.sh`'s words.
 *
 * Every label and every sentence below is one of the script's `report` or
 * `die` lines, so that the handover which moves the install onto this command
 * can move `install.sh.integration.test.ts`'s `planned()` assertions over
 * without rewording one of them. The manifests are written by
 * `updateVersionsManifest`, the function the release job writes the real one
 * through, rather than typed as JSON.
 */

const HOME = '/home/alice';
const MIRROR = '/mirror/versions.json';
const RELEASES = 'https://github.com/SoftieSolutions/agentplex/releases/download';
const VERSIONS_URL = 'https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/versions.json';

const BOTH_LEGS = { client: 3, server: 3 };

function manifest(
  releases: readonly (readonly [string, string, ReleaseProtocol])[],
): VersionsManifest {
  return releases.reduce<VersionsManifest>(
    (previous, [component, version, protocol]) =>
      updateVersionsManifest(previous, component, { version, protocol }),
    {},
  );
}

/** A release where every component agrees on both legs. */
const CURRENT = manifest([
  ['cli', '1.3.0', {}],
  ['cli', '1.4.0', {}],
  ['hub', '1.1.0', BOTH_LEGS],
  ['hub', '1.2.0', BOTH_LEGS],
  ['web', '1.1.0', BOTH_LEGS],
  ['server', '1.5.0', { server: 3 }],
]);

function flags(argv: readonly string[]): InstallRequest {
  const read = readInstallFlags(argv);
  if (!read.ok) throw new Error(read.problem);
  return read.value;
}

function input(
  argv: readonly string[],
  overrides: Partial<Omit<InstallPlanInput, 'request'>> = {},
): InstallPlanInput {
  return {
    request: flags(argv),
    layout: userLayout(HOME),
    release: { kind: 'manifest', source: MIRROR, manifest: CURRENT },
    settingsPresent: false,
    unitsPresent: [],
    unitSkipReason: null,
    ...overrides,
  };
}

function lines(planned: InstallPlanInput): readonly PlanLine[] {
  const plan = planInstall(planned);
  if (!plan.ok) throw new Error(`stopped: ${plan.problem}`);
  return plan.lines;
}

/** `planned()` from `install.sh.integration.test.ts`: one label's text, or nothing. */
function planned(planned: InstallPlanInput, label: string): string | undefined {
  return lines(planned).find((line) => line.label === label)?.text;
}

function stopped(planned: InstallPlanInput): string {
  const plan = planInstall(planned);
  if (plan.ok) throw new Error('planned where it should have stopped');
  return plan.problem;
}

function url(component: string, version: string, asset: string): string {
  return `${RELEASES}/${component}-v${version}/${asset}`;
}

describe('the release line', () => {
  it('takes what the manifest calls current when nothing is pinned', () => {
    const hub = input(['--role=hub', '--dry-run']);

    expect(planned(hub, 'release')).toBe(`cli 1.4.0, hub 1.2.0, web 1.1.0 (from ${MIRROR})`);
    expect(planned(hub, 'client protocol')).toBe('3, which hub and web agree on');
    expect(planned(hub, 'server protocol')).toBe('3, which hub and web agree on');
    expect(planned(hub, 'package')).toBe(
      [
        url('cli', '1.4.0', 'agentplex.tgz'),
        url('hub', '1.2.0', 'agentplex-hub.tgz'),
        url('web', '1.1.0', 'agentplex-web.tgz'),
      ].join(' ') + ` into ${HOME}/.agentplex`,
    );
  });

  it('says a leg nothing here speaks is not spoken, and names a lone speaker', () => {
    const server = input(['--role=server', '--dry-run']);

    expect(planned(server, 'release')).toBe(`cli 1.4.0, server 1.5.0 (from ${MIRROR})`);
    expect(planned(server, 'client protocol')).toBe('not spoken by anything this machine installs');
    expect(planned(server, 'server protocol')).toBe('3, which server agrees on');
  });

  it('lists every speaker of a leg on a machine that runs both', () => {
    const both = input(['--dry-run']);

    expect(planned(both, 'release')).toBe(
      `cli 1.4.0, hub 1.2.0, web 1.1.0, server 1.5.0 (from ${MIRROR})`,
    );
    expect(planned(both, 'server protocol')).toBe('3, which hub, web and server agree on');
  });

  it('takes an exact pin the manifest lists, with the legs that release records', () => {
    const pinned = input(['--role=hub@1.1.0', '--package-version=1.3.0', '--dry-run']);

    expect(planned(pinned, 'release')).toBe(`cli 1.3.0, hub 1.1.0, web 1.1.0 (from ${MIRROR})`);
  });

  it('resolves a series to the newest release under it, as the one table says', () => {
    const table = SERIES_RESOLUTION_CASES.find((one) => one.expect === '1.3.10');
    if (table === undefined) throw new Error('the series table lost its numeric-patch case');
    const history = manifest([
      ['cli', '1.4.0', {}],
      ['web', '1.1.0', BOTH_LEGS],
      ...table.releases.map((version) => ['hub', version, BOTH_LEGS] as const),
    ]);

    const series = input([`--role=hub@${table.series}`, '--dry-run'], {
      release: { kind: 'manifest', source: MIRROR, manifest: history },
    });

    expect(planned(series, 'release')).toBe(`cli 1.4.0, hub 1.3.10, web 1.1.0 (from ${MIRROR})`);
  });

  it('stops on a series the manifest holds nothing in, naming it', () => {
    expect(stopped(input(['--role=hub@7', '--dry-run']))).toBe(
      `${MIRROR} offers no hub release under 7, so hub@7 names a series it advertises nothing ` +
        'in. A series takes the newest release under it and never a prerelease; a prerelease ' +
        'named exactly is installed',
    );
  });

  it('stops on an exact pin the manifest does not list, naming it', () => {
    expect(stopped(input(['--role=hub@1.9.0', '--dry-run']))).toBe(
      `${MIRROR} offers no hub release at 1.9.0, so there is nothing here to install hub-v1.9.0 ` +
        'from. This file is the set of releases it advertises and not the set of tags that ' +
        'exist: a 2.x release is advertised from its own branch, and a mirror holds whatever ' +
        'was copied into it',
    );
  });

  it('stops on a manifest that names no entry for a component this machine installs', () => {
    const noWeb = manifest([
      ['cli', '1.4.0', {}],
      ['hub', '1.2.0', BOTH_LEGS],
    ]);

    expect(
      stopped(
        input(['--role=hub', '--dry-run'], {
          release: { kind: 'manifest', source: MIRROR, manifest: noWeb },
        }),
      ),
    ).toBe(
      `${MIRROR} names no web, and this machine installs one. It is the manifest of every ` +
        'release of every component, so a missing entry is a release that did not finish ' +
        'rather than something to guess at',
    );
  });

  it('stops on a leg two components disagree about, naming both and the leg', () => {
    const client = manifest([
      ['cli', '1.4.0', {}],
      ['hub', '1.2.0', BOTH_LEGS],
      ['web', '1.1.0', { client: 4, server: 3 }],
    ]);
    const server = manifest([
      ['cli', '1.4.0', {}],
      ['hub', '1.2.0', BOTH_LEGS],
      ['web', '1.1.0', BOTH_LEGS],
      ['server', '1.5.0', { server: 4 }],
    ]);

    expect(
      stopped(
        input(['--role=hub', '--dry-run'], {
          release: { kind: 'manifest', source: MIRROR, manifest: client },
        }),
      ),
    ).toBe(
      'this machine would install a hub speaking client protocol 3 and a web speaking client ' +
        'protocol 4, and two components that disagree about the client protocol do not talk to ' +
        'each other. A change to a leg releases every component that records it together, so ' +
        'this is a broken release rather than a choice to make: nothing has been installed',
    );
    expect(
      stopped(
        input(['--dry-run'], { release: { kind: 'manifest', source: MIRROR, manifest: server } }),
      ),
    ).toContain('a hub speaking server protocol 3 and a server speaking server protocol 4');
  });
});

describe('a dry run with no manifest to read', () => {
  const unread: ReleaseInput = { kind: 'unread' };

  it('answers an exact pin, leaves a series and the unpinned unresolved, and says why', () => {
    const plan = input(['--role=hub@1.3', '--package-version=1.4.0', '--dry-run'], {
      release: unread,
    });

    expect(planned(plan, 'release')).toBe(
      'cli 1.4.0, hub (not resolved), web (not resolved): a dry run downloads nothing, and ' +
        `${VERSIONS_URL} is a download`,
    );
    for (const leg of ['client protocol', 'server protocol']) {
      expect(planned(plan, leg)).toBe(
        'not checked: a dry run downloads nothing, and the file that says what a release ' +
          'speaks is a download',
      );
    }
    expect(planned(plan, 'package')).toBe(
      `cli hub web from ${RELEASES} into ${HOME}/.agentplex, at whatever versions the line ` +
        'above resolves to',
    );
  });

  it('builds every URL when every component is pinned exactly', () => {
    const plan = input(['--role=server@1.5.0', '--package-version=1.4.0', '--dry-run'], {
      release: unread,
    });

    expect(planned(plan, 'package')).toBe(
      `${url('cli', '1.4.0', 'agentplex.tgz')} ${url('server', '1.5.0', 'agentplex-server.tgz')}` +
        ` into ${HOME}/.agentplex`,
    );
  });
});

describe('AGENTPLEX_PACKAGE', () => {
  const directory = '/build/packages';
  const entries = [
    'softiesolutions-agentplex-hub-0.0.0.tgz',
    'softiesolutions-agentplex-server-0.0.0.tgz',
    'softiesolutions-agentplex-web-0.0.0.tgz',
    'softiesolutions-agentplex-0.0.0.tgz',
    'README.md',
  ];

  it('names the tarballs, resolves no version and checks no protocol', () => {
    const plan = input(['--role=hub', '--dry-run'], {
      release: { kind: 'tarballs', directory, entries },
    });

    expect(planned(plan, 'release')).toBe(
      `the tarballs in ${directory}; no version is resolved and no protocol is checked, because ` +
        'a directory of tarballs is one build and not a release',
    );
    expect(planned(plan, 'client protocol')).toBeUndefined();
    expect(planned(plan, 'server protocol')).toBeUndefined();
    // The command's own tarball is picked by the digit after its name, so the
    // hub's, which starts with the same words, is not taken for it.
    expect(planned(plan, 'package')).toBe(
      [
        `${directory}/softiesolutions-agentplex-0.0.0.tgz`,
        `${directory}/softiesolutions-agentplex-hub-0.0.0.tgz`,
        `${directory}/softiesolutions-agentplex-web-0.0.0.tgz`,
      ].join(' ') + ` into ${HOME}/.agentplex`,
    );
  });

  it('stops when a package the role needs has no tarball there', () => {
    expect(
      stopped(
        input(['--role=hub', '--dry-run'], {
          release: {
            kind: 'tarballs',
            directory,
            entries: entries.filter((one) => !one.includes('-web-')),
          },
        }),
      ),
    ).toBe(
      `no softiesolutions-agentplex-web-<version>.tgz in ${directory}, and --role=hub installs ` +
        '@softiesolutions/agentplex-web. A directory missing one of the packages a role needs ' +
        'would install the rest and quietly leave that one to a registry',
    );
  });

  it('stops when it names something that is not a directory', () => {
    expect(
      stopped(
        input(['--role=hub', '--dry-run'], {
          release: { kind: 'tarballs', directory, entries: null },
        }),
      ),
    ).toBe(
      `AGENTPLEX_PACKAGE names "${directory}", which is not a directory: it is the directory ` +
        'holding the packed tarballs to install, one per package',
    );
  });
});

describe('what the plan says about the machine', () => {
  const system: Layout = systemLayout();

  it('reports ownership under --system only', () => {
    expect(planned(input(['--role=hub', '--dry-run']), 'ownership')).toBeUndefined();
    expect(
      planned(input(['--role=hub', '--system', '--dry-run'], { layout: system }), 'ownership'),
    ).toBe(
      'agentplex owns /opt/agentplex/bin, /opt/agentplex/lib/node_modules, /opt/agentplex/share ' +
        'and /var/lib/agentplex; root keeps /opt/agentplex/node and /etc/agentplex/agentplex.env',
    );
  });

  it('creates the settings file, or leaves one that is there alone', () => {
    expect(planned(input(['--dry-run']), 'settings')).toBe(
      `${HOME}/.agentplex/agentplex.env (create)`,
    );
    expect(planned(input(['--dry-run'], { settingsPresent: true }), 'settings')).toBe(
      `${HOME}/.agentplex/agentplex.env (already there, left alone)`,
    );
  });

  it('writes each unit, leaves one that is there alone, or skips them with the reason', () => {
    const units = `${HOME}/.config/systemd/user`;
    const plan = input(['--dry-run'], { unitsPresent: [`${units}/agentplex-server.service`] });

    expect(
      lines(plan)
        .filter((line) => line.label === 'unit')
        .map((line) => line.text),
    ).toEqual([
      `${units}/agentplex-hub.service (write, not enabled)`,
      `${units}/agentplex-server.service (already there, left alone; --print-unit shows this version)`,
    ]);
    expect(
      lines(input(['--dry-run'], { unitSkipReason: 'no systemctl on this machine' }))
        .filter((line) => line.label === 'unit')
        .map((line) => line.text),
    ).toEqual(['skipped: no systemctl on this machine']);
  });

  it('says it all in the order install.sh reports it', () => {
    expect(
      lines(input(['--role=hub', '--system', '--dry-run'], { layout: system })).map(
        (line) => line.label,
      ),
    ).toEqual([
      'release',
      'client protocol',
      'server protocol',
      'package',
      'ownership',
      'settings',
      'unit',
    ]);
  });
});

describe('formatPlanLine', () => {
  it("pads the label as report()'s printf '%-10s %s' does, and lets a long one run over", () => {
    expect(formatPlanLine({ label: 'release', text: 'cli 1.4.0' })).toBe('release    cli 1.4.0');
    expect(formatPlanLine({ label: 'client protocol', text: '3' })).toBe('client protocol 3');
  });
});

describe('unitSkipReason', () => {
  it('answers as resolve_unit_support does', () => {
    expect(unitSkipReason('darwin', true)).toBe(
      'macOS has no systemd, hand the process to launchd',
    );
    expect(unitSkipReason('linux', false)).toBe('no systemctl on this machine');
    expect(unitSkipReason('linux', true)).toBeNull();
  });
});
