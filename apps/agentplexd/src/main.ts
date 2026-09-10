#!/usr/bin/env node
import process from 'node:process';
import {
  childEnvironment,
  childSearchPath,
  systemClock,
  createLogger,
  jsonLineSink,
} from '@agentplex/node-shared';
import { loadConfig, usage } from './config/config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';
import {
  createNodeProcessProbe,
  createNodeProgramResolver,
  nodeStoreFileSystem,
  createNodeProcessRunner,
  createClaudeAdapter,
  nodeProviderFiles,
  createProviderPreflight,
  createProviderRegistry,
} from '@agentplex/providers';

/**
 * The entrypoint is wiring and process concerns only: argv, env, stdout,
 * signals, exit codes. Every rule lives in a sibling module that a test can
 * reach without opening a port.
 *
 * The shebang above is the whole of what makes this file a command. `bin` in a
 * package.json is a path, not an interpreter: npm links `agentplexd` at that
 * path and marks it executable, and the kernel then hands a file with no `#!`
 * to the shell, which reads `import process from 'node:process'` as a command
 * called `import`. Nothing in this repository noticed, because the image and
 * every script here start it as `node .../main.js`. `tsc` copies a leading
 * shebang into the emitted file, so the built `dist/main.js` carries it too.
 */

/** Configuration was wrong. Restarting will not help; the operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/**
 * `doctor` found something this machine cannot do.
 *
 * The same 1, deliberately: to a script `agentplexd doctor` is a check, and a
 * check that says "not ready" has failed in the only sense a shell understands.
 * Nothing here distinguishes a missing provider from an unmounted store by
 * code, because the report already does, in words, on stdout.
 */
const EXIT_NOT_READY = 1;

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);
  const argv = process.argv.slice(2);

  const loaded = loadConfig({ argv, env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplexd: ${problem}\n`);
    process.stderr.write(`\n${usage()}\n`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  // The service logs on stdout, because that is what a supervisor collects.
  // `doctor` gives stdout to its report and puts its own log lines on stderr,
  // so that what an operator reads -- or pipes into an issue -- is the report
  // and not the report with a JSON line about a probe in the middle of it.
  const logger = createLogger(config.logLevel, jsonLineSink(writeError, systemClock));

  // What every child of this process gets, composed once: what agentplexd
  // inherited, with the configured directories ahead of its PATH. Both spawn
  // seams below take it at construction, so nothing downstream has an
  // environment to read or a variable to add.
  const environment = childEnvironment({ inherited: process.env, binPath: config.server.binPath });

  // The one place a one-shot child is started. Every operation shares this
  // runner, so what a child inherits is decided above and cannot be added to
  // further down.
  const processRunner = createNodeProcessRunner({ environment });

  // Where a bare program name will actually resolve, read back out of the
  // environment composed above rather than out of the setting that shaped it.
  // The preflight's whole value is that its answer is the one a spawn would
  // reach, and a second list built from `binPath` here could differ from the
  // first the day the composition changes.
  const programs = createNodeProgramResolver(childSearchPath(environment));

  // What this build drives, in one line, shared by `doctor` and by the service.
  // Adding codex is another adapter file and another entry here, and nothing
  // else.
  const providers = createProviderRegistry([
    createClaudeAdapter({
      files: nodeProviderFiles,
      probe: createNodeProcessProbe({ runner: processRunner }),
    }),
  ]);

  // What those adapters turn out to be on this machine, asked once. The service
  // asks it at boot and carries the answer into every handshake; `doctor` asks
  // it and prints it. One implementation, so the two can never disagree about
  // whether a binary is there -- which is exactly the moment somebody is
  // staring at a machine wondering why a session will not start.
  const preflight = createProviderPreflight({ programs, probes: processRunner, logger });

  {
    // Read-only, and then it exits. Nothing below this line runs: no port is
    // bound, no database is opened, no store file is minted.
    const report = await inspectMachine(config, {
      providers,
      preflight,
      files: nodeStoreFileSystem,
    });
    for (const line of formatDoctorReport(report)) write(line);
    if (!report.usable) process.exitCode = EXIT_NOT_READY;
    return;
  }
}

await main();
