import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import type { ProgramResolver } from '@agentplex/providers';
import { describe, expect, it } from 'vitest';
import { createFakeInstallationFiles } from './fake-installation-files.js';
import { userLayout } from './layout.js';
import { NODE_MAJOR, resolveNodeDirectory } from './node-directory.js';
import { declared } from './test-install-script.js';

/**
 * Which interpreter a unit names, chosen as `resolve_node_directory` chooses
 * it: the prefix's own runtime when it is there and recent, else the `node` a
 * PATH lookup finds when that one is recent, else the prefix's runtime
 * directory, where the installer is about to unpack one.
 *
 * Never the interpreter this process runs under. That is the resolved real
 * path, so a Homebrew or version-manager node would be written into the unit as
 * a versioned directory the next upgrade of that node deletes.
 */

const LAYOUT = userLayout('/home/alice');
const OWNED = '/home/alice/.agentplex/node/bin';
const SHIMS = '/home/alice/.nvm/versions/node/v24.9.0/bin';

function programs(found: Readonly<Record<string, string>>): ProgramResolver {
  return { resolve: async (name) => found[name] ?? null };
}

describe('resolveNodeDirectory', () => {
  it('takes the prefix runtime when it is there and recent, whatever PATH holds', async () => {
    const runner = createFakeProcessRunner({
      outcomes: {
        [`${OWNED}/node --version`]: printed('v24.9.0\n'),
        [`${SHIMS}/node --version`]: printed('v24.10.0\n'),
      },
    });

    const directory = await resolveNodeDirectory(LAYOUT, {
      files: createFakeInstallationFiles({ present: [`${OWNED}/node`] }),
      programs: programs({ node: SHIMS }),
      runner,
    });

    expect(directory).toBe(OWNED);
    expect(runner.requests.map((one) => [one.file, ...one.args])).toEqual([
      [`${OWNED}/node`, '--version'],
    ]);
  });

  it('adopts the node on PATH when the prefix holds none', async () => {
    const directory = await resolveNodeDirectory(LAYOUT, {
      files: createFakeInstallationFiles(),
      programs: programs({ node: SHIMS }),
      runner: createFakeProcessRunner({
        outcomes: { [`${SHIMS}/node --version`]: printed('v24.9.0\n') },
      }),
    });

    expect(directory).toBe(SHIMS);
  });

  it('passes over a prefix runtime that is too old, or will not say its version', async () => {
    for (const answer of [
      printed('v22.1.0\n'),
      refused(1, 'cannot execute'),
      printed('banana\n'),
    ]) {
      const directory = await resolveNodeDirectory(LAYOUT, {
        files: createFakeInstallationFiles({ present: [`${OWNED}/node`] }),
        programs: programs({ node: SHIMS }),
        runner: createFakeProcessRunner({
          outcomes: {
            [`${OWNED}/node --version`]: answer,
            [`${SHIMS}/node --version`]: printed('v24.9.0\n'),
          },
        }),
      });

      expect(directory).toBe(SHIMS);
    }
  });

  it('answers the prefix runtime directory when nothing recent is anywhere', async () => {
    const tooOld = await resolveNodeDirectory(LAYOUT, {
      files: createFakeInstallationFiles(),
      programs: programs({ node: '/usr/bin' }),
      runner: createFakeProcessRunner({
        outcomes: { '/usr/bin/node --version': printed('v18.19.0\n') },
      }),
    });
    const none = await resolveNodeDirectory(LAYOUT, {
      files: createFakeInstallationFiles(),
      programs: programs({}),
      runner: createFakeProcessRunner(),
    });

    expect(tooOld).toBe(OWNED);
    expect(none).toBe(OWNED);
  });

  it('counts a newer major as recent, as node_major_is_recent does', async () => {
    const directory = await resolveNodeDirectory(LAYOUT, {
      files: createFakeInstallationFiles(),
      programs: programs({ node: '/usr/local/bin' }),
      runner: createFakeProcessRunner({
        outcomes: { '/usr/local/bin/node --version': printed('v26.0.0\n') },
      }),
    });

    expect(directory).toBe('/usr/local/bin');
  });

  it('asks for the major install.sh declares', () => {
    expect(NODE_MAJOR).toBe(declared('NODE_MAJOR'));
  });
});
