import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { runOperation } from '@agentplex/providers';
import { osNameOperation } from './os-name.js';

/**
 * The fixture is `sw_vers` run with no arguments on the macOS machine this
 * ticket was written on, redirected to a file: the three `Key:\t\tvalue` lines,
 * tabs and all. The tab count is the kind of detail a hand-written fixture
 * gets wrong, and a parser that split on one tab would pass against it.
 */
const SW_VERS = readFileSync(join(import.meta.dirname, 'fixtures', 'sw-vers-macos.txt'), 'utf8');

/** Spelled out rather than read off the operation: a fixed argv, with nothing a request adds. */
const COMMAND_LINE = 'sw_vers';

describe('system.os-name', () => {
  it('names the marketing product and its version out of real sw_vers output', async () => {
    const runner = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(SW_VERS) } });

    const outcome = await runOperation(osNameOperation, {}, runner);

    expect(outcome).toEqual({ ok: true, result: 'macOS 26.6.2' });
    expect(runner.requests).toEqual([{ file: 'sw_vers', args: [], timeoutMs: 2_000 }]);
  });

  it('takes no request fields, so nothing a caller sends can reach the argv', async () => {
    const runner = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(SW_VERS) } });

    const outcome = await runOperation(osNameOperation, { flag: '--help' }, runner);

    expect(outcome).toMatchObject({ ok: false, refusal: 'invalid-request' });
    expect(runner.requests).toEqual([]);
  });

  it('is unavailable where there is no sw_vers, which is every machine but a Mac', async () => {
    const outcome = await runOperation(osNameOperation, {}, createFakeProcessRunner());

    expect(outcome).toMatchObject({ ok: false, refusal: 'unavailable' });
  });

  it('fails on an exit it did not expect, rather than naming whatever was printed', async () => {
    const runner = createFakeProcessRunner({
      outcomes: { [COMMAND_LINE]: refused(1, "sw_vers: unrecognized option `--bogus'") },
    });

    expect(await runOperation(osNameOperation, {}, runner)).toMatchObject({
      ok: false,
      refusal: 'failed',
    });
  });

  it('fails when either half of the name is missing from the output', async () => {
    // Only the lines this capture holds, each dropped in turn: a product with
    // no version, and a version of nothing, are both less than a name.
    for (const key of ['ProductName', 'ProductVersion']) {
      const without = SW_VERS.split('\n')
        .filter((line) => !line.startsWith(`${key}:`))
        .join('\n');
      const runner = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(without) } });

      expect(await runOperation(osNameOperation, {}, runner), key).toMatchObject({
        ok: false,
        refusal: 'failed',
      });
    }
  });

  it('fails on a name the wire would refuse, rather than sending a frame the hub rejects', async () => {
    const runner = createFakeProcessRunner({
      outcomes: {
        [COMMAND_LINE]: printed(SW_VERS.replace('macOS', `macOS\u001b[2J${'x'.repeat(80)}`)),
      },
    });

    expect(await runOperation(osNameOperation, {}, runner)).toMatchObject({
      ok: false,
      refusal: 'failed',
    });
  });
});
