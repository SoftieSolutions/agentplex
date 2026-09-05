import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../server/fake-process-probe.js';
import { printed, refused } from '../server/operations/fake-process-runner.js';
import { createClaudeAdapter } from '../server/providers/claude-adapter.js';
import { createFakeProviderFiles } from '../server/providers/fake-provider-files.js';
import { createProviderRegistry } from '../server/providers/provider-registry.js';
import { createFakeMachine, type FakeMachine } from './fake-machine.js';
import { createFakeSetupMachine } from './fake-setup-machine.js';
import type { SetupMachine } from './setup-machine.js';
import { surveyMachine } from './survey-machine.js';

/**
 * What setup can find out for itself.
 *
 * The adoption rule lives here, and every assertion below is about it. An
 * operator's existing `claude` is the one they authenticated; a second copy
 * installed into an owned prefix and put first on PATH would shadow a working,
 * logged-in binary with a fresh one that is not, and the failure would present
 * as an authentication bug with no visible cause. So the survey's job is to know
 * whether there is one, exactly which directory it is in, and whether it can
 * actually be run — before a plan is built rather than after a machine is.
 */

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', 'server', 'providers', 'fixtures', name),
    'utf8',
  );
}

const HOME = '/home/dev';
const HOMEBREW = '/opt/homebrew/bin';
const LOCAL = '/home/dev/.local/bin';

function providers() {
  return createProviderRegistry([
    createClaudeAdapter({ files: createFakeProviderFiles(), probe: createFakeProcessProbe({}) }),
  ]);
}

interface Surveyed {
  readonly survey: Awaited<ReturnType<typeof surveyMachine>>;
  readonly runner: FakeMachine;
  /** The binPath each runner the survey asked for was built from, in order. */
  readonly binPaths: readonly (readonly string[])[];
}

async function survey(options: {
  readonly machine: SetupMachine;
  readonly runner?: FakeMachine;
}): Promise<Surveyed> {
  const runner = options.runner ?? createFakeMachine();
  const binPaths: (readonly string[])[] = [];

  const result = await surveyMachine({
    machine: options.machine,
    providers: providers(),
    runnerFor: (binPath) => {
      binPaths.push(binPath);
      return runner;
    },
  });

  return { survey: result, runner, binPaths };
}

/** A machine with Claude Code where homebrew puts it, logged in. */
function withHomebrewClaude(): { machine: SetupMachine; runner: FakeMachine } {
  return {
    machine: createFakeSetupMachine({
      home: HOME,
      pathDirectories: ['/usr/bin', HOMEBREW],
      directories: [`${HOME}/.claude`],
      executables: [`${HOMEBREW}/claude`],
    }),
    runner: createFakeMachine({
      programs: {
        'claude --version': printed(fixture('claude-version.txt')),
        'claude auth status --json': printed(fixture('claude-auth-status-logged-in.json')),
      },
    }),
  };
}

describe('surveying a machine', () => {
  it('adopts the provider on the operator PATH and records the directory it is in', async () => {
    const surveyed = await survey(withHomebrewClaude());

    expect(surveyed.survey.providers).toEqual([
      {
        provider: 'claude',
        program: 'claude',
        foundIn: [HOMEBREW],
        version: '2.1.259',
        versionProblem: null,
        authState: 'authenticated',
        authProblem: null,
      },
    ]);
  });

  it('probes the copy it is about to record, in the directory it found it in', async () => {
    // The directory setup writes into a plan has to be the directory the version
    // it reports came out of. Probing through some other PATH would report the
    // version of a binary that is not the one the server will resolve.
    const surveyed = await survey(withHomebrewClaude());

    expect(surveyed.binPaths).toEqual([[HOMEBREW], [HOMEBREW]]);
  });

  it('starts nothing when there is no provider to start', async () => {
    const surveyed = await survey({
      machine: createFakeSetupMachine({ home: HOME, pathDirectories: ['/usr/bin', HOMEBREW] }),
    });

    expect(surveyed.survey.providers).toEqual([
      {
        provider: 'claude',
        program: 'claude',
        foundIn: [],
        version: null,
        versionProblem: null,
        authState: null,
        authProblem: null,
      },
    ]);
    // A probe of a program that is not there is an ENOENT nobody learns
    // anything from, and it would read as a failure in the report.
    expect(surveyed.runner.requests).toEqual([]);
  });

  it('reports a provider that is there and cannot say what it is, in its own words', async () => {
    // The version-manager shim, and the npm install whose postinstall did not
    // run: a program that resolves and cannot answer. The probe is run here,
    // while a person is present to act on it, rather than at the first spawn of
    // the first session — which is the whole reason it is at setup time.
    const surveyed = await survey({
      machine: createFakeSetupMachine({
        home: HOME,
        pathDirectories: [LOCAL],
        executables: [`${LOCAL}/claude`],
      }),
      runner: createFakeMachine({
        programs: {
          'claude --version': refused(1, fixture('claude-version-no-native-binary.txt')),
        },
      }),
    });

    const claude = surveyed.survey.providers[0]!;
    expect(claude.foundIn).toEqual([LOCAL]);
    expect(claude.version).toBeNull();
    expect(claude.versionProblem).toContain('claude native binary not installed');
    // Asking a binary that cannot report its version whether it is logged in is
    // a second failure carrying no new fact, and it would read as a logout.
    expect(claude.authState).toBeNull();
    expect(surveyed.runner.requests.map((request) => request.args)).toEqual([['--version']]);
  });

  it('keeps a logged-out provider adoptable, and says so', async () => {
    const { machine } = withHomebrewClaude();
    const surveyed = await survey({
      machine,
      runner: createFakeMachine({
        programs: {
          'claude --version': printed(fixture('claude-version.txt')),
          'claude auth status --json': {
            kind: 'exited',
            exitCode: 1,
            stdout: fixture('claude-auth-status-logged-out.json'),
            stderr: '',
          },
        },
      }),
    });

    const claude = surveyed.survey.providers[0]!;
    expect(claude.version).toBe('2.1.259');
    expect(claude.authState).toBe('unauthenticated');
    expect(claude.versionProblem).toBeNull();
  });

  it('names every directory holding a copy, in the order they resolve', async () => {
    // Two copies on one PATH is the fact behind a version that surprises
    // somebody later. The first is the one that runs; the rest cost nothing to
    // have found while a person is present.
    const { runner } = withHomebrewClaude();
    const surveyed = await survey({
      machine: createFakeSetupMachine({
        home: HOME,
        pathDirectories: [LOCAL, HOMEBREW],
        executables: [`${LOCAL}/claude`, `${HOMEBREW}/claude`],
      }),
      runner,
    });

    expect(surveyed.survey.providers[0]!.foundIn).toEqual([LOCAL, HOMEBREW]);
    expect(surveyed.binPaths[0]).toEqual([LOCAL]);
  });

  it('offers the store a provider already keeps its state in', async () => {
    const surveyed = await survey(withHomebrewClaude());

    expect(surveyed.survey.stores).toEqual([`${HOME}/.claude`]);
  });

  it('offers no store on a machine where the provider has never run', async () => {
    // Offering a directory that is not there would be the wizard inventing a
    // store, and a store minted in an empty directory is a store with no
    // sessions in it that the hub then reports as real.
    const surveyed = await survey({
      machine: createFakeSetupMachine({ home: HOME, pathDirectories: [HOMEBREW] }),
    });

    expect(surveyed.survey.stores).toEqual([]);
  });
});
