import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { createNodeProcessRunner } from './node-process-runner.js';

/**
 * These start real processes, because every claim in this file is about what
 * the operating system does and none of them is settled until it has been run
 * at the origin. A fake runner proves what an operation does with output; only
 * a real spawn proves there is no shell between the argv and the child.
 *
 * The program under test is the node binary running these tests. It is the one
 * executable certain to exist on a developer's mac and inside
 * `node:24-bookworm-slim`, which ships neither `ps` nor much else — a suite
 * built on `sh` or `echo` would pass locally and be quietly meaningless in the
 * image agentplexd actually deploys as.
 *
 * `-e` is a code string, which is exactly what nothing else in this codebase is
 * allowed to build. It is legitimate here for the same reason a crash test uses
 * a real wall: the string is written in this file, never assembled from input,
 * and it is the only way to make the child report what it was actually handed.
 */

const node = process.execPath;
const runner = createNodeProcessRunner({ environment: process.env });

/** Enough for a process to start and print on a loaded CI machine. */
const TIMEOUT_MS = 20_000;

describe('createNodeProcessRunner', () => {
  it('runs a program and reports what it printed', async () => {
    const outcome = await runner.run({
      file: node,
      args: ['--version'],
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 });
    if (outcome.kind === 'exited') {
      expect(outcome.stdout.trim()).toBe(process.version);
    }
  });

  it('hands every argument to the child exactly as given', async () => {
    // Spaces, a variable reference, a redirect, a command separator, a glob. A
    // shell would split, expand, redirect and fork on these; the child gets
    // them as three strings because there is no shell to do any of it.
    const hostile = ['a b', '$HOME', '; rm -rf / > /tmp/x || echo *'];

    const outcome = await runner.run({
      file: node,
      args: ['-e', 'process.stdout.write(process.argv.slice(1).join("\\n"))', ...hostile],
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 });
    if (outcome.kind === 'exited') expect(outcome.stdout.split('\n')).toEqual(hostile);
  });

  it('gives the child the environment the runner was built with, and no other', async () => {
    const sealed = createNodeProcessRunner({ environment: { AGENTPLEX_ONLY: 'yes' } });

    const outcome = await sealed.run({
      file: node,
      args: [
        '-e',
        'process.stdout.write(`${process.env.AGENTPLEX_ONLY}:${process.env.HOME ?? "unset"}`)',
      ],
      timeoutMs: TIMEOUT_MS,
    });

    // The variable that was injected is there and `HOME` — which this very
    // process certainly has — is not. Nothing an operation does can reach this
    // environment, and this is what that looks like from inside the child.
    expect(outcome).toMatchObject({ kind: 'exited', stdout: 'yes:unset' });
  });

  it('starts the child in agentplexd own directory, never one a caller chose', async () => {
    const outcome = await runner.run({
      file: node,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      timeoutMs: TIMEOUT_MS,
    });

    // The seam has no cwd field, so there is nothing to assert but this: the
    // child inherits, and a directory an operation cares about has to travel as
    // an argument the program itself understands.
    expect(outcome).toMatchObject({ kind: 'exited', stdout: process.cwd() });
  });

  it('reports a program that answered no as an exit, not a failure', async () => {
    const outcome = await runner.run({
      file: node,
      args: ['--no-such-flag-exists'],
      timeoutMs: TIMEOUT_MS,
    });

    // The difference matters upstream: an operation decides what a nonzero exit
    // means, and it can only do that if the exit reached it.
    expect(outcome.kind).toBe('exited');
    if (outcome.kind === 'exited') {
      expect(outcome.exitCode).toBeGreaterThan(0);
      expect(outcome.stderr).not.toBe('');
    }
  });

  it('reports a program that is not installed as the machine failing', async () => {
    const outcome = await runner.run({
      file: 'agentplex-no-such-program',
      args: [],
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome).toMatchObject({ kind: 'failed' });
    if (outcome.kind === 'failed') expect(outcome.problem).toContain('agentplex-no-such-program');
  });

  it('kills a program that will not finish in time', async () => {
    const outcome = await runner.run({
      file: node,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 250,
    });

    expect(outcome).toMatchObject({ kind: 'failed' });
    if (outcome.kind === 'failed') expect(outcome.problem).toContain('250ms');
  });
});
