import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed } from './fake-process-runner.js';
import { createOperationRegistry } from './operation-registry.js';

/**
 * These are the tests about the registry as a rule rather than about any one
 * operation: what happens to a name nobody registered, and what every
 * registered operation must have in common.
 *
 * The sweep at the bottom is the one that has to keep passing after this
 * milestone. It runs over whatever the registry holds, so an operation added in
 * a year is checked by a test written today — which is the only way a rule about
 * "every spawn" survives the people who were not in the room for it.
 */

const DIRECTORY = '/srv/work';
const GIT_STATUS = `git --no-optional-locks -C ${DIRECTORY} status --porcelain=v2 --branch`;
const CLEAN = '# branch.oid abc\n# branch.head main\n';

describe('the operation registry', () => {
  it('runs an operation it knows by name', async () => {
    const runner = createFakeProcessRunner({ outcomes: { [GIT_STATUS]: printed(CLEAN) } });
    const registry = createOperationRegistry(runner);

    const outcome = await registry.execute('git.status', { directory: DIRECTORY });

    expect(outcome).toEqual({
      ok: true,
      result: { branch: 'main', upstream: null, ahead: 0, behind: 0, changes: 0 },
    });
  });

  it('refuses a name it does not have, and starts nothing', async () => {
    const runner = createFakeProcessRunner();
    const registry = createOperationRegistry(runner);

    // The names a generic-command frame would carry, if one existed. None of
    // them is a program here; each is a word that failed a lookup.
    for (const name of ['sh', 'exec', 'run', 'git', 'git.status ; rm -rf /', '']) {
      const outcome = await registry.execute(name, { directory: DIRECTORY });
      expect(outcome).toMatchObject({ ok: false, refusal: 'unknown-operation' });
    }

    expect(runner.requests).toEqual([]);
  });

  it('refuses a known operation asked for something ill-formed, and starts nothing', async () => {
    const runner = createFakeProcessRunner();
    const registry = createOperationRegistry(runner);

    // Including the shapes a caller would reach for to smuggle argv past the
    // parser: extra fields are rejected outright, not carried along.
    for (const request of [
      undefined,
      'git status',
      { directory: DIRECTORY, args: ['--upload-pack=touch /tmp/pwned'] },
      { directory: ['--help'] },
    ]) {
      expect(await registry.execute('git.status', request)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }

    expect(runner.requests).toEqual([]);
  });

  it('lists what this build can run', async () => {
    const registry = createOperationRegistry(createFakeProcessRunner());

    expect(registry.operations.map(({ name }) => name)).toEqual([
      'git.status',
      'process.start-time',
    ]);
    for (const { summary } of registry.operations) expect(summary).not.toBe('');
  });

  it('gives every operation a name that is a name and not a command', () => {
    const registry = createOperationRegistry(createFakeProcessRunner());

    for (const { name } of registry.operations) {
      // A dotted identifier: `git.status` is a thing the server does, not a
      // command line it runs. Anything with a space, a slash or a shell
      // metacharacter in it would be the beginning of the failure mode the
      // registry exists to prevent.
      expect(name).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/);
    }
  });

  it('builds every spawn as a bare argv, with no cwd and no environment', async () => {
    const runner = createFakeProcessRunner();
    const registry = createOperationRegistry(runner);

    // One valid request per operation, listed here rather than derived, so that
    // adding an operation forces someone to write down what a valid request to
    // it looks like — and brings it under every assertion below.
    const requests: Readonly<Record<string, unknown>> = {
      'git.status': { directory: DIRECTORY },
      'process.start-time': { pid: 42 },
    };
    expect(Object.keys(requests).sort()).toEqual(
      registry.operations.map(({ name }) => name).sort(),
    );

    for (const [name, request] of Object.entries(requests)) {
      // The runner has no such program, so nothing runs; the request is
      // recorded before that is discovered, which is what this is reading.
      await registry.execute(name, request);
    }

    expect(runner.requests).toHaveLength(registry.operations.length);
    for (const request of runner.requests) {
      // Three fields, and these three. A cwd, an env or a shell flag on a spawn
      // would have to appear here first, and this is where it fails.
      expect(Object.keys(request).sort()).toEqual(['args', 'file', 'timeoutMs']);
      // A program name PATH resolves, never a path and never a line to be
      // split: `/bin/sh -c ...` cannot be spelled in this shape.
      expect(request.file).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const argument of request.args) expect(typeof argument).toBe('string');
      expect(request.timeoutMs).toBeGreaterThan(0);
    }

    // And the directory really did reach git as an argument it parses.
    expect(runner.requests[0]?.args).toContain('-C');
    expect(runner.requests[0]?.args).toContain(DIRECTORY);
  });

  it('starts no child for any operation until its request has parsed', async () => {
    const runner = createFakeProcessRunner();
    const registry = createOperationRegistry(runner);

    // Whatever the registry holds, now and later: a request nothing can parse
    // must never reach an argv builder, because a builder is the only thing
    // that chooses what runs.
    for (const { name } of registry.operations) {
      const outcome = await registry.execute(name, { nothing: 'that any operation asked for' });
      expect(outcome).toMatchObject({ ok: false, refusal: 'invalid-request' });
    }

    expect(runner.requests).toEqual([]);
  });
});
