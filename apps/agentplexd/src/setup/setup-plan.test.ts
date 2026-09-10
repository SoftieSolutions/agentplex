import { describe, expect, it } from 'vitest';
import { ROLES } from '../config/config.js';
import {
  parseSetupPlan,
  serializeSetupPlan,
  setupBinPath,
  SETUP_PLAN_VERSION,
} from './setup-plan.js';

/**
 * The plan file, as the thing it is: a claim that arrived from disk.
 *
 * Every test here is a file somebody could write — by hand into EC2 user-data,
 * or by the wizard's save screen — rather than an object built in TypeScript,
 * because the parser's whole job is the JSON boundary and a test that starts on
 * the far side of it tests nothing.
 */

const ONE_BOX = `{
  "version": 1,
  "role": "both",
  "hub": { "port": 8080 },
  "server": {
    "port": 8081,
    "storePaths": ["/home/dev/.claude"],
    "binPath": ["/opt/homebrew/bin"],
    "identityPath": "/home/dev/.agentplex/server.json",
    "installPrefix": "/home/dev/.agentplex",
    "providers": [{ "provider": "claude", "version": null }]
  }
}
`;

function plan(server: Record<string, unknown>): string {
  return JSON.stringify({ version: SETUP_PLAN_VERSION, role: 'server', server });
}

const SERVER_HALF = {
  port: 8081,
  storePaths: ['/srv/work'],
  binPath: [],
  identityPath: '/var/lib/agentplex/server.json',
  installPrefix: '/var/lib/agentplex',
  providers: [{ provider: 'claude', version: '2.1.259' }],
};

/** Long enough to be a token rather than a password somebody picked. */
const PRE_MINTED = 'x'.repeat(43);

function problems(contents: string): readonly string[] {
  const parsed = parseSetupPlan(contents);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems;
}

describe('the setup plan parser', () => {
  it('reads the one-box plan the wizard would save', () => {
    const parsed = parseSetupPlan(ONE_BOX);

    expect(parsed).toEqual({
      ok: true,
      plan: {
        version: SETUP_PLAN_VERSION,
        role: 'both',
        hub: { port: 8080 },
        server: {
          port: 8081,
          storePaths: ['/home/dev/.claude'],
          binPath: ['/opt/homebrew/bin'],
          identityPath: '/home/dev/.agentplex/server.json',
          installPrefix: '/home/dev/.agentplex',
          pairingToken: null,
          providers: [{ provider: 'claude', version: null }],
        },
      },
    });
  });

  it('reads a server plan carrying a pre-minted pairing token', () => {
    // The EC2 tier: an instance that is pairable the moment it boots, because
    // the token it will answer to was decided before the machine existed.
    const parsed = parseSetupPlan(plan({ ...SERVER_HALF, pairingToken: PRE_MINTED }));

    expect(parsed).toMatchObject({ ok: true, plan: { server: { pairingToken: PRE_MINTED } } });
  });

  it('reads a hub plan that has no server half at all', () => {
    const parsed = parseSetupPlan(`{ "version": 1, "role": "hub", "hub": { "port": 443 } }`);

    expect(parsed).toEqual({
      ok: true,
      plan: { version: SETUP_PLAN_VERSION, role: 'hub', hub: { port: 443 } },
    });
  });

  it('expresses every role agentplexd can be started in', () => {
    // The two lists have to stay one list. A plan that can describe a role the
    // daemon does not have — or cannot describe one it does — is an artifact
    // that provisions a machine nobody can start, and the failure would land on
    // whoever replayed it rather than on whoever added the role.
    const halves: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
      hub: { hub: { port: 8080 } },
      server: { server: SERVER_HALF },
      both: { hub: { port: 8080 }, server: SERVER_HALF },
    };

    for (const role of ROLES) {
      const parsed = parseSetupPlan(
        JSON.stringify({ version: SETUP_PLAN_VERSION, role, ...halves[role] }),
      );
      expect(parsed).toMatchObject({ ok: true, plan: { role } });
    }
  });

  it('refuses a role whose half is missing', () => {
    // Not a shrug and not a default. `--role=both` with no server half is
    // somebody who deleted the wrong block, and provisioning half of what they
    // meant is worse than telling them.
    expect(problems(`{ "version": 1, "role": "both", "hub": { "port": 8080 } }`)).toEqual([
      expect.stringContaining('server'),
    ]);
  });

  it('refuses a file that is not JSON', () => {
    expect(problems('role: both\n')).toEqual([expect.stringContaining('not JSON')]);
  });

  it('refuses a plan written in a format this build does not know', () => {
    // The first thing parsed is what shape the file claims to be. A build that
    // met a version 2 plan and read the fields it recognised would provision a
    // machine the plan does not describe, silently, which is the one outcome a
    // replayable artifact must not have.
    for (const contents of [
      `{ "version": 2, "role": "hub", "hub": { "port": 8080 } }`,
      `{ "role": "hub", "hub": { "port": 8080 } }`,
    ]) {
      expect(problems(contents)).toEqual([expect.stringContaining('version')]);
    }
  });

  it('refuses a key nobody registered rather than ignoring it', () => {
    // A plan file is hand-edited. `storePath` for `storePaths` would otherwise
    // parse as a server that watches nothing, and the operator would find out
    // when the hub reported no stores on a machine full of them.
    expect(problems(plan({ ...SERVER_HALF, storePath: ['/srv/work'] }))).toEqual([
      expect.stringContaining('storePath'),
    ]);
  });

  it('refuses every path that is not absolute, and says which', () => {
    // The reason `ServerConfig` gives, one step earlier: a relative path in a
    // plan replayed from cloud-init means whatever directory cloud-init left the
    // process in, so the same artifact describes a different machine each time.
    const relative = problems(
      plan({
        ...SERVER_HALF,
        storePaths: ['work'],
        binPath: ['bin'],
        identityPath: 'server.json',
        installPrefix: '.agentplex',
      }),
    );

    expect(relative).toHaveLength(4);
    for (const field of ['storePaths', 'binPath', 'identityPath', 'installPrefix']) {
      expect(relative).toContainEqual(expect.stringContaining(field));
    }
  });

  it('normalises a path to one spelling and lists a directory once', () => {
    const parsed = parseSetupPlan(
      plan({
        ...SERVER_HALF,
        storePaths: ['/srv/work/', '/srv/agents/../work', '/srv/other'],
        binPath: ['/usr/local/bin', '/usr/local/bin'],
      }),
    );

    // Order is search order and is kept; a directory spelled two ways is one
    // directory, and a plan that named it twice does not watch it twice.
    expect(parsed).toMatchObject({
      ok: true,
      plan: { server: { storePaths: ['/srv/work', '/srv/other'], binPath: ['/usr/local/bin'] } },
    });
  });

  it('refuses a port that is not a port', () => {
    // JSON has numbers, so a number is what this reads. `"8080"` is a plan
    // written by something that stringified its settings, and coercing it here
    // would accept the next thing that arrives as a string too.
    for (const port of ['"8081"', '0', '65536', '8081.5', 'null']) {
      expect(problems(plan({ ...SERVER_HALF, port: JSON.parse(port) }))).toEqual([
        expect.stringContaining('port'),
      ]);
    }
  });

  it('refuses a provider name nobody has heard of', () => {
    expect(
      problems(plan({ ...SERVER_HALF, providers: [{ provider: 'cursor', version: null }] })),
    ).toEqual([expect.stringContaining('provider')]);
  });

  it('accepts a provider this build has no adapter for', () => {
    // The plan is a description of a machine, not of this binary. `codex` is a
    // provider agentplex knows; whether *this* build can drive it is the
    // registry's answer at apply time, and it is a different refusal with a
    // different remedy.
    expect(
      parseSetupPlan(plan({ ...SERVER_HALF, providers: [{ provider: 'codex', version: null }] })),
    ).toMatchObject({ ok: true });
  });

  it('refuses two entries for one provider', () => {
    // The rule the whole ticket turns on, at the earliest point it can be
    // enforced: a plan that names claude twice is a plan that installs it twice,
    // and the second pin silently wins.
    expect(
      problems(
        plan({
          ...SERVER_HALF,
          providers: [
            { provider: 'claude', version: '2.1.259' },
            { provider: 'claude', version: null },
          ],
        }),
      ),
    ).toEqual([expect.stringContaining('claude')]);
  });

  it('refuses a pairing token short enough to be guessed', () => {
    expect(problems(plan({ ...SERVER_HALF, pairingToken: 'letmein' }))).toEqual([
      expect.stringContaining('pairingToken'),
    ]);
  });

  it('reports every problem rather than the first', () => {
    // A plan replayed unattended fails whole. Fixing one field per boot is the
    // loop `ConfigResult` exists to avoid, and a file is no different.
    expect(problems(plan({ ...SERVER_HALF, port: 0, identityPath: 'server.json' }))).toHaveLength(
      2,
    );
  });
});

describe('the directories a setup run resolves programs in', () => {
  it('searches what the plan recorded, then the prefix agentplex installs into', () => {
    const parsed = parseSetupPlan(ONE_BOX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The order is the whole point. The operator's own directories come first,
    // so an adopted binary keeps winning; the owned prefix is last and is what
    // makes a second replay find what the first one installed.
    expect(setupBinPath(parsed.plan)).toEqual(['/opt/homebrew/bin', '/home/dev/.agentplex/bin']);
  });

  it('is empty for a hub, which spawns no provider', () => {
    const parsed = parseSetupPlan(`{ "version": 1, "role": "hub", "hub": { "port": 8080 } }`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(setupBinPath(parsed.plan)).toEqual([]);
  });
});

describe('writing a plan back out', () => {
  it('writes a file this parser reads as the same plan', () => {
    // The property the wizard's last screen depends on. What it saves has to be
    // an artifact the unattended front end replays into the same machine, and a
    // serializer agreeing with the parser about everything except one field
    // would produce a file that provisions a machine nobody described.
    const parsed = parseSetupPlan(ONE_BOX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parseSetupPlan(serializeSetupPlan(parsed.plan))).toEqual(parsed);
  });

  it('writes a file a person can open and edit', () => {
    const parsed = parseSetupPlan(ONE_BOX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const written = serializeSetupPlan(parsed.plan);

    expect(written).toContain('\n  "role": "both"');
    expect(written.endsWith('\n')).toBe(true);
  });
});
