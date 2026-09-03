import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { createNodeProcessProbe } from './node-process-probe.js';
import { createNodeProcessRunner } from './operations/node-process-runner.js';

/**
 * These run against this very process, on whatever platform is running them.
 *
 * That is the point. Every other test in this area drives the seam with a fake
 * process table, which proves the judgement and nothing about the platform; the
 * one claim a fake cannot check is that `/proc` arithmetic and `ps` output
 * really do date a process on the machine agentplexd runs on. This suite runs
 * on macOS locally and on Linux in the container, which is exactly the two
 * implementations below the seam.
 *
 * The real runner, not a fake, for the same reason: on macOS this is the path
 * through the operation registry to a real `ps`, and a fake would stub out the
 * only part that has ever been platform-specific.
 */
const nodeProcessProbe = createNodeProcessProbe({
  runner: createNodeProcessRunner({ environment: process.env }),
});

/**
 * Beyond any pid a kernel will hand out — Linux caps `pid_max` at 2^22 and
 * macOS at 99998 — so it is reliably absent without killing anything to make
 * it so, and cannot be recycled underneath the assertion.
 */
const NO_SUCH_PID = 2_147_483_647;

describe('nodeProcessProbe.isAlive', () => {
  it('finds the process asking', async () => {
    expect(await nodeProcessProbe.isAlive(process.pid)).toBe(true);
  });

  it('does not find a pid no kernel will have issued', async () => {
    expect(await nodeProcessProbe.isAlive(NO_SUCH_PID)).toBe(false);
  });

  it('refuses the pids that mean something else to kill', async () => {
    // `process.kill(0, 0)` signals the whole process group and a negative pid
    // signals a group by id. Both would report "alive" for a question nobody
    // asked, so they are rejected before the syscall.
    expect(await nodeProcessProbe.isAlive(0)).toBe(false);
    expect(await nodeProcessProbe.isAlive(-1)).toBe(false);
  });
});

describe('nodeProcessProbe.startedAt', () => {
  it('dates this process to when this process actually started', async () => {
    const startedAt = await nodeProcessProbe.startedAt(process.pid);
    expect(startedAt).not.toBeNull();

    // Node's own account of the same fact, from a different source entirely:
    // `uptime()` counts from runtime start, a shade after the kernel created
    // the process, so the probe may land slightly earlier and never later.
    const byUptime = Date.now() - process.uptime() * 1000;
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(Math.abs((startedAt ?? 0) - byUptime)).toBeLessThan(10_000);
  });

  it('will not date a pid that is not there', async () => {
    expect(await nodeProcessProbe.startedAt(NO_SUCH_PID)).toBeNull();
  });
});
