#!/usr/bin/env node
import process from 'node:process';
import {
  childEnvironment,
  childSearchPath,
  createLogger,
  jsonLineSink,
  systemClock,
  wantsHelp,
} from '@agentplex/node-shared';
import {
  createClaudeAdapter,
  createNodeProcessProbe,
  createNodeProcessRunner,
  createNodeProgramResolver,
  createProviderPreflight,
  createProviderRegistry,
  nodeProviderFiles,
  nodeStoreFileSystem,
} from '@agentplex/providers';
import { checkNodePty } from '@agentplex/pty';
import { doctorUsage, loadDoctorConfig } from './config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';

/**
 * `agentplex doctor`: read the settings, inspect the machine, print the
 * report, exit. It binds no port, opens no database, opens no pty and writes
 * nothing, and this program cannot: it depends on nothing that provisions, and
 * the one thing it borrows from `pty` is the question of whether the addon
 * loads -- `createPtySupervisor` is not reachable from here, so there is no
 * expression in this program that could open one. A check is easier to trust
 * when the program running it cannot change what it checks.
 *
 * The report goes to stdout and this program's own log lines to stderr, so
 * that what an operator reads -- or pipes into an issue -- is the report and
 * not the report with a JSON line about a probe in the middle of it.
 */

/** Configuration was wrong. The operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/**
 * Something this machine cannot do. To a script a doctor is a check, and a
 * check that says "not ready" has failed in the only sense a shell understands.
 * Nothing here distinguishes a missing provider from an unmounted store by
 * code, because the report already does, in words, on stdout.
 */
const EXIT_NOT_READY = 1;

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);

  // Before the settings, and before anything is inspected. The reader under
  // them refuses a flag that is not a setting, `--help` is not one, and what
  // this program's flags are is true of the program rather than of the machine
  // -- so the question is answered without a probe, and with the exit code of a
  // program that did what it was asked rather than a verdict on the machine.
  if (wantsHelp(process.argv.slice(2))) {
    write(doctorUsage());
    return;
  }

  const loaded = loadDoctorConfig({ argv: process.argv.slice(2), env: process.env });
  if (!loaded.ok) {
    for (const problem of loaded.problems) writeError(`agentplex doctor: ${problem}`);
    writeError(`\n${doctorUsage()}`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  const logger = createLogger(config.logLevel, jsonLineSink(writeError, systemClock));

  // What a child of the server would get, composed the way the server composes
  // it, so the preflight's answer is the one a spawn would reach. A hub-only
  // machine has no server half to read directories from and inherits as is.
  const environment = childEnvironment({
    inherited: process.env,
    binPath: 'server' in config ? config.server.binPath : [],
  });
  const processRunner = createNodeProcessRunner({ environment });
  const programs = createNodeProgramResolver(childSearchPath(environment));

  // The same adapters the server drives, in the same one line.
  const providers = createProviderRegistry([
    createClaudeAdapter({
      files: nodeProviderFiles,
      probe: createNodeProcessProbe({ runner: processRunner }),
    }),
  ]);

  // The same preflight the server runs at boot. One implementation, so the two
  // can never disagree about whether a binary is there -- which is exactly the
  // moment somebody is staring at a machine wondering why a session will not
  // start.
  const preflight = createProviderPreflight({ programs, probes: processRunner, logger });

  const report = await inspectMachine(config, {
    providers,
    preflight,
    files: nodeStoreFileSystem,
    // The same call the server makes before it will start, so the two can never
    // disagree about whether this machine can run a session at all.
    terminals: checkNodePty,
  });
  for (const line of formatDoctorReport(report)) write(line);
  if (!report.usable) process.exitCode = EXIT_NOT_READY;
}

await main();
