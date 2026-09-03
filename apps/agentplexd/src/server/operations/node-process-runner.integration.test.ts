import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { childEnvironment } from '../../config/child-environment.js';
import { createProbeProgram } from '../probe-program.js';
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

/**
 * The claim `binPath` exists to make: what resolves a bare program name is the
 * list of directories the deployment recorded, and nothing else.
 *
 * The inherited environment here has an empty PATH, which is the worst case of
 * what systemd hands a unit — worse than real, deliberately, because a test
 * that leaves the developer's own PATH in place cannot tell a program found in
 * `binPath` from one found in `/opt/homebrew/bin`.
 */
describe('createNodeProcessRunner with a configured binPath', () => {
  const probe = createProbeProgram();
  afterAll(() => probe.remove());

  const inherited = { PATH: '' };

  it('resolves a bare program name from a configured directory', async () => {
    const runner = createNodeProcessRunner({
      environment: childEnvironment({ inherited, binPath: [probe.directory] }),
    });

    const outcome = await runner.run({
      file: probe.name,
      args: ['-e', 'process.stdout.write("resolved")'],
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0, stdout: 'resolved' });
  });

  it('finds nothing without it, which is what makes the test above about binPath', async () => {
    const runner = createNodeProcessRunner({
      environment: childEnvironment({ inherited, binPath: [] }),
    });

    const outcome = await runner.run({ file: probe.name, args: [], timeoutMs: TIMEOUT_MS });

    expect(outcome).toMatchObject({ kind: 'failed' });
  });

  it('gives the child exactly the configured directories as its PATH', async () => {
    // Read out of the child's own environment rather than out of the record
    // built for it: the whole failure this fixes is a PATH that was one thing
    // where the operator looked and another where the child ran.
    const runner = createNodeProcessRunner({
      environment: childEnvironment({
        inherited: { PATH: '/usr/sbin' },
        binPath: [probe.directory],
      }),
    });

    const outcome = await runner.run({
      file: probe.name,
      args: ['-e', 'process.stdout.write(process.env.PATH ?? "unset")'],
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome).toMatchObject({ kind: 'exited', stdout: probe.directory });
  });
});
