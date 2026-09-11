import { describe, expect, it } from 'vitest';
import type { Installation } from '../../installation/installation.js';
import { userLayout } from '../../installation/layout.js';
import { createFakeNetwork } from './fake-update-machine.js';
import { NODE_DIST_URL, checkRuntime } from './runtime.js';

/**
 * Which Node release the dist URL names, and whether it is the one this prefix
 * has.
 *
 * The swap itself is exercised end to end in `update-command.test.ts`, where
 * the order it happens in is the thing worth asserting. What is here is the
 * reading of `SHASUMS256.txt`, which is a file off the network whose hash is
 * about to decide whether a downloaded archive is the one that was asked for.
 */

const SUMS = `${NODE_DIST_URL}/SHASUMS256.txt`;

/** What nodejs.org really serves, cut down: `<sha256>  <file>`, one per line. */
const CHECKSUMS = [
  `${'1'.repeat(64)}  node-v24.10.0-darwin-arm64.tar.gz`,
  `${'2'.repeat(64)}  node-v24.10.0-linux-arm64.tar.gz`,
  `${'3'.repeat(64)}  node-v24.10.0-linux-x64.tar.gz`,
  `${'4'.repeat(64)}  node-v24.10.0-linux-x64.tar.xz`,
].join('\n');

function installation(runtime: Installation['runtime']): Installation {
  return {
    layout: userLayout('/home/alice'),
    role: 'both',
    packages: [],
    units: [],
    runtime,
  };
}

function check(
  runtime: Installation['runtime'],
  served: Readonly<Record<string, string>> = { [SUMS]: CHECKSUMS },
  platform: 'linux' | 'darwin' = 'linux',
  architecture: 'x64' | 'arm64' = 'x64',
) {
  return checkRuntime(installation(runtime), {
    reader: createFakeNetwork({ served }),
    platform,
    architecture,
  });
}

describe('which runtime is named', () => {
  it('takes the version out of the file name and the hash off the same line', async () => {
    expect(await check({ kind: 'installed', version: 'v24.9.0' })).toEqual({
      kind: 'stale',
      installed: 'v24.9.0',
      available: 'v24.10.0',
      url: `${NODE_DIST_URL}/node-v24.10.0-linux-x64.tar.gz`,
      checksum: '3'.repeat(64),
    });
  });

  /**
   * `.tar.gz` and not `.tar.xz`: a stock `debian:bookworm-slim` has `tar` and
   * no `xz`, so the archive that needs a package installed before it can be
   * unpacked is the one that must never be chosen.
   */
  it('picks the gzip archive for this platform and architecture', async () => {
    const arm = await check({ kind: 'installed', version: 'v24.9.0' }, undefined, 'linux', 'arm64');

    expect(arm).toMatchObject({ url: `${NODE_DIST_URL}/node-v24.10.0-linux-arm64.tar.gz` });
  });

  it('says the stamped release is current when it is the one named', async () => {
    expect(await check({ kind: 'installed', version: 'v24.10.0' })).toEqual({
      kind: 'current',
      version: 'v24.10.0',
    });
  });

  /**
   * `install.sh` stamps a runtime only when it unpacked one, so no stamp means
   * the install adopted a Node the machine already had -- somebody's system
   * package, somebody's version manager. Replacing that would be taking
   * ownership of a directory this command does not own, and `uninstall_node`
   * bets on the same record.
   */
  it('never asks about a runtime the install adopted', async () => {
    const network = createFakeNetwork({ served: { [SUMS]: CHECKSUMS } });

    const decided = await checkRuntime(installation({ kind: 'adopted' }), {
      reader: network,
      platform: 'linux',
      architecture: 'x64',
    });

    expect(decided).toEqual({ kind: 'adopted' });
    expect(network.requests).toEqual([]);
  });
});

describe('when it cannot be asked', () => {
  /**
   * The degrade `install.sh` already makes about nodejs.org: the runtime here
   * is the one that was here, and whether a newer one exists is unknown rather
   * than no.
   */
  it('says the question went unanswered rather than that nothing is newer', async () => {
    const decided = await check({ kind: 'installed', version: 'v24.9.0' }, {});

    expect(decided).toMatchObject({ kind: 'unknown', installed: 'v24.9.0' });
  });

  it('says so when nothing in the release builds for this machine', async () => {
    const decided = await check(
      { kind: 'installed', version: 'v24.9.0' },
      { [SUMS]: CHECKSUMS },
      'darwin',
      'x64',
    );

    expect(decided).toMatchObject({ kind: 'unknown' });
    expect(decided.kind === 'unknown' && decided.problem).toContain('darwin-x64');
  });

  /**
   * Parsed rather than read. The first field decides whether a fifty-megabyte
   * download is the one nodejs.org published, so a line that is not a checksum
   * and a file name is skipped rather than compared against.
   */
  it('skips a line whose first field is not a sha256', async () => {
    const decided = await check(
      { kind: 'installed', version: 'v24.9.0' },
      {
        [SUMS]: [
          'oops  node-v24.11.0-linux-x64.tar.gz',
          `${'3'.repeat(64)}  node-v24.10.0-linux-x64.tar.gz`,
        ].join('\n'),
      },
    );

    expect(decided).toMatchObject({ available: 'v24.10.0' });
  });

  it('skips a file name that is not a release version', async () => {
    const decided = await check(
      { kind: 'installed', version: 'v24.9.0' },
      {
        [SUMS]: `${'3'.repeat(64)}  node-nightly-linux-x64.tar.gz`,
      },
    );

    expect(decided).toMatchObject({ kind: 'unknown' });
  });
});
