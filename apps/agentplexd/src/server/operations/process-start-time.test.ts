import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessRunner, printed, refused } from './fake-process-runner.js';
import { runOperation } from './operation.js';
import { processStartTimeOperation } from './process-start-time.js';

/**
 * Captured `ps -p <pid> -o lstart=` output, from macOS 25.2 — trailing column
 * padding and all, which is why this file is in the prettier ignore list.
 *
 * The two observations that matter were made at the origin rather than
 * remembered. `ps` prints the moment in the machine's local zone with no zone
 * marker, so it is parsed as local time and the expectation below is built the
 * same way, which makes this test true in any `TZ`. And `ps` answers a pid it
 * cannot find with exit 1 and no output at all, on either stream: there is no
 * message to quote, so the refusal has to be written rather than forwarded.
 */
const LSTART = readFileSync(join(import.meta.dirname, 'fixtures', 'ps-lstart.txt'), 'utf8');

/** The moment in the fixture, in the zone `ps` printed it in: the local one. */
const STARTED_AT = new Date(2026, 8, 3, 2, 4, 46).getTime();

const PID = 4242;
const COMMAND_LINE = `ps -p ${PID} -o lstart=`;

describe('process.start-time', () => {
  it('dates a process from real ps output', async () => {
    const fake = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(LSTART) } });

    const outcome = await runOperation(processStartTimeOperation, { pid: PID }, fake);

    expect(outcome).toEqual({ ok: true, result: { startedAt: STARTED_AT } });
  });

  it('asks ps about exactly the pid it was given, as argv', async () => {
    const fake = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed(LSTART) } });
    await runOperation(processStartTimeOperation, { pid: PID }, fake);

    expect(fake.requests).toEqual([
      {
        file: 'ps',
        args: ['-p', String(PID), '-o', 'lstart='],
        timeoutMs: processStartTimeOperation.timeoutMs,
      },
    ]);
  });

  it('refuses the pids that mean something else to a kernel', async () => {
    const fake = createFakeProcessRunner();

    // 0 is every process in the group and a negative one is a group by id.
    // Neither is a process to date, and neither reaches `ps`.
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(await runOperation(processStartTimeOperation, { pid }, fake)).toMatchObject({
        ok: false,
        refusal: 'invalid-request',
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it('will not date a pid ps has nothing to say about', async () => {
    // Exit 1 and silence, which is exactly what a real `ps` does for a pid that
    // is gone. Unverifiable is the answer, and the caller must read it as "do
    // not claim" rather than as a date.
    const fake = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: refused(1, '') } });

    expect(await runOperation(processStartTimeOperation, { pid: PID }, fake)).toMatchObject({
      ok: false,
      refusal: 'failed',
    });
  });

  it('will not date a process from output it cannot read as a date', async () => {
    const fake = createFakeProcessRunner({ outcomes: { [COMMAND_LINE]: printed('yesterday\n') } });

    expect(await runOperation(processStartTimeOperation, { pid: PID }, fake)).toMatchObject({
      ok: false,
      refusal: 'failed',
    });
  });

  it('says the machine could not run it where there is no ps', async () => {
    // The deployment image is `node:24-bookworm-slim`, which ships no `ps` at
    // all. That has to be distinguishable from "this pid is gone": one is a
    // fact about the process, the other about the machine.
    expect(
      await runOperation(processStartTimeOperation, { pid: PID }, createFakeProcessRunner()),
    ).toMatchObject({ ok: false, refusal: 'unavailable' });
  });
});
