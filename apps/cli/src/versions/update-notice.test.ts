import { describe, expect, it } from 'vitest';
import { createFakeDetachedSpawner } from '@agentplex/providers/testing';
import { createFakeInstallationFiles } from '../installation/fake-installation-files.js';
import { NO_UPDATE_CHECK_FLAG, noticeWanted, withoutNoticeFlag } from './notice-flags.js';
import { updateNotice } from './update-notice.js';
import { CACHE_MAX_AGE_MS, serializeCachedVersions } from './versions-cache.js';

/**
 * The passive notice, which is mostly a set of refusals.
 *
 * The load-bearing one is asserted first and is asserted structurally: the
 * notice is handed a read-only filesystem and a spawner that starts nothing, so
 * there is no seam here through which a network call could be made. What the
 * tests below add to that is the behaviour that makes the absence survivable --
 * a stale cache asks for a refresh instead of fetching one, and says nothing
 * while it waits for next time.
 */

const CACHE = '/home/alice/.cache/agentplex/versions.json';
const NOW = 1_800_000_000_000;
const BIN = '/home/alice/.agentplex/lib/node_modules/@softiesolutions/agentplex/dist/main.js';

function cached(age: number, cliVersion = '1.5.0'): string {
  return serializeCachedVersions({
    checkedAt: NOW - age,
    source: 'https://example.invalid/versions.json',
    manifest: { cli: { version: cliVersion, protocol: 3 } },
  });
}

async function notice(
  options: {
    readonly cache?: string | null;
    readonly running?: string | null;
  } = {},
): Promise<{ readonly lines: readonly string[]; readonly refreshes: number }> {
  const spawner = createFakeDetachedSpawner();
  const files = createFakeInstallationFiles({
    files: options.cache === null || options.cache === undefined ? {} : { [CACHE]: options.cache },
  });

  const lines = await updateNotice({
    files,
    now: () => NOW,
    spawner,
    cacheFile: CACHE,
    runningVersion: options.running === undefined ? '1.4.0' : options.running,
    interpreter: '/usr/bin/node',
    entrypoint: BIN,
  });

  return { lines, refreshes: spawner.started.length };
}

describe('what the notice says', () => {
  it('names the version, what is running, and when it last looked', async () => {
    const said = await notice({ cache: cached(2 * 60 * 60 * 1000) });

    expect(said.lines[0]).toBe(
      'agentplex 1.5.0 is available; you are running 1.4.0 (checked 2 hours ago)',
    );
    expect(said.lines[1]).toContain('agentplex update');
    // A fresh cache is not refreshed: the whole point is that the ordinary run
    // costs one small read and starts nothing.
    expect(said.refreshes).toBe(0);
  });

  it('says nothing when the cached version is the one running', async () => {
    expect((await notice({ cache: cached(0, '1.4.0') })).lines).toEqual([]);
  });

  it('says nothing when what is published is older than what is running', async () => {
    expect((await notice({ cache: cached(0, '1.3.0') })).lines).toEqual([]);
  });

  /**
   * Nothing in this workspace is versioned -- the tag is the statement -- so a
   * checkout reports `0.0.0`. A notice under every command a contributor runs
   * is a notice they learn to ignore.
   */
  it('says nothing to a build that carries no released version', async () => {
    expect((await notice({ cache: cached(0), running: '0.0.0' })).lines).toEqual([]);
    expect((await notice({ cache: cached(0), running: null })).lines).toEqual([]);
  });
});

describe('the cache, and the refresh it asks for', () => {
  /**
   * The constraint the whole design rests on: a stale cache is a request for a
   * refresh and silence this run, not a fetch. The refresh is a detached child,
   * so "a refresh was requested" is a value here and "a refresh happened" would
   * need a process.
   */
  it('asks for a refresh and says nothing when the cache is too old', async () => {
    const said = await notice({ cache: cached(CACHE_MAX_AGE_MS + 1) });

    expect(said.lines).toEqual([]);
    expect(said.refreshes).toBe(1);
  });

  it('asks for a refresh when there is no cache at all', async () => {
    expect((await notice({ cache: null })).refreshes).toBe(1);
  });

  /** A truncated file heals: it is refused as a cache and a refresh is asked for. */
  it('asks for a refresh when the cache is not readable as one', async () => {
    const said = await notice({ cache: '{"checkedAt": "yesterday"}' });

    expect(said.lines).toEqual([]);
    expect(said.refreshes).toBe(1);
  });

  /**
   * The refresh runs this machine's own agentplex, which is what makes
   * `--check` the one version-check mechanism rather than the second one.
   */
  it('runs update --check, with the notice turned off in the child', async () => {
    const spawner = createFakeDetachedSpawner();

    await updateNotice({
      files: createFakeInstallationFiles({}),
      now: () => NOW,
      spawner,
      cacheFile: CACHE,
      runningVersion: '1.4.0',
      interpreter: '/usr/bin/node',
      entrypoint: BIN,
    });

    expect(spawner.started).toEqual([
      { file: '/usr/bin/node', args: [BIN, 'update', '--check', NO_UPDATE_CHECK_FLAG] },
    ]);
  });

  /** A machine with nowhere to keep a cache does without a notice, quietly. */
  it('says nothing and asks for nothing when there is nowhere to cache', async () => {
    const spawner = createFakeDetachedSpawner();

    const lines = await updateNotice({
      files: createFakeInstallationFiles({}),
      now: () => NOW,
      spawner,
      cacheFile: null,
      runningVersion: '1.4.0',
      interpreter: '/usr/bin/node',
      entrypoint: BIN,
    });

    expect(lines).toEqual([]);
    expect(spawner.started).toEqual([]);
  });
});

describe('whether anybody is reading', () => {
  const wanted = (overrides: Partial<Parameters<typeof noticeWanted>[0]> = {}): boolean =>
    noticeWanted({ stderrIsTty: true, environment: {}, argv: [], ...overrides });

  it('is off when stderr is not a terminal, which is every pipe and every log', () => {
    expect(wanted()).toBe(true);
    expect(wanted({ stderrIsTty: false })).toBe(false);
  });

  it('is off under the environment variable, whatever it says', () => {
    expect(wanted({ environment: { AGENTPLEX_NO_UPDATE_CHECK: '1' } })).toBe(false);
    expect(wanted({ environment: { AGENTPLEX_NO_UPDATE_CHECK: '0' } })).toBe(false);
    expect(wanted({ environment: { AGENTPLEX_NO_UPDATE_CHECK: '' } })).toBe(true);
  });

  it('is off with the flag', () => {
    expect(wanted({ argv: ['status', NO_UPDATE_CHECK_FLAG] })).toBe(false);
  });

  /**
   * Every command refuses an argument it does not know, so a flag the bin
   * handles has to be gone before the command sees it.
   */
  it('takes the flag back out of an argv', () => {
    expect(withoutNoticeFlag(['status', NO_UPDATE_CHECK_FLAG, '--system'])).toEqual([
      'status',
      '--system',
    ]);
  });
});
