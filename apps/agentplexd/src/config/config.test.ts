import { describe, expect, it } from 'vitest';
import { loadConfig, type ConfigResult } from './config.js';

const DATABASE_URL = 'postgres://agentplex@localhost:5432/agentplex';

function load(argv: string[], env: Record<string, string | undefined> = {}): ConfigResult {
  return loadConfig({ argv, env });
}

function expectProblems(result: ConfigResult): readonly string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('loadConfig roles', () => {
  it('reads the role from a flag', () => {
    const result = load(['--role=server']);
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('reads the role from the environment when no flag is given', () => {
    const result = load([], { AGENTPLEX_ROLE: 'server' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('lets a flag override the environment, because a flag was just typed', () => {
    const result = load(['--role=server'], { AGENTPLEX_ROLE: 'hub' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('refuses to start with no role rather than picking one', () => {
    expect(expectProblems(load([]))[0]).toContain('no role');
  });

  it('names the accepted roles when given an unknown one', () => {
    const problems = expectProblems(load(['--role=worker']));
    expect(problems[0]).toContain('hub, server, both');
  });

  it('gives the both role a hub and a server half', () => {
    const result = load(['--role=both', `--database-url=${DATABASE_URL}`]);
    expect(result).toMatchObject({
      ok: true,
      config: { role: 'both', hub: { databaseUrl: DATABASE_URL }, server: { port: 8081 } },
    });
  });
});

describe('loadConfig database url', () => {
  it('requires one for the hub role', () => {
    const problems = expectProblems(load(['--role=hub']));
    expect(problems).toEqual([
      'the hub role needs a database: set AGENTPLEX_DATABASE_URL or pass --database-url',
    ]);
  });

  it('requires one for the both role', () => {
    expect(expectProblems(load(['--role=both']))).toHaveLength(1);
  });

  it('does not require one for the server role, which owns no database', () => {
    const result = load(['--role=server']);
    expect(result.ok).toBe(true);
  });
});

describe('loadConfig ports', () => {
  it('defaults the two ports so a first run needs no port decision', () => {
    const result = load(['--role=both', `--database-url=${DATABASE_URL}`]);
    expect(result).toMatchObject({
      ok: true,
      config: { hub: { port: 8080 }, server: { port: 8081 } },
    });
  });

  it('accepts a flag value given as a separate argument', () => {
    const result = load(['--role', 'server', '--server-port', '9000']);
    expect(result).toMatchObject({ ok: true, config: { server: { port: 9000 } } });
  });

  it('refuses a port outside the valid range instead of letting bind fail later', () => {
    expect(expectProblems(load(['--role=server', '--server-port=70000']))).toHaveLength(1);
    expect(expectProblems(load(['--role=server', '--server-port=0']))).toHaveLength(1);
  });

  it('refuses a port that is not a number', () => {
    const problems = expectProblems(load(['--role=server', '--server-port=eight']));
    expect(problems[0]).toContain('port number');
  });
});

describe('loadConfig failure reporting', () => {
  it('reports every problem at once rather than one env var per restart', () => {
    const problems = expectProblems(load(['--role=hub', '--hub-port=abc', '--log-level=loud']));
    expect(problems).toHaveLength(3);
  });

  it('refuses an unknown flag rather than silently ignoring a typo', () => {
    const problems = expectProblems(load(['--role=server', '--databse-url=x']));
    expect(problems[0]).toContain('--databse-url');
  });

  it('refuses a flag left without a value', () => {
    const problems = expectProblems(load(['--role', '--server-port=9000']));
    expect(problems[0]).toContain('--role needs a value');
  });

  it('treats an empty environment variable as absent, not as an empty value', () => {
    const problems = expectProblems(load([], { AGENTPLEX_ROLE: '   ' }));
    expect(problems[0]).toContain('no role');
  });
});

describe('loadConfig log level', () => {
  it('defaults to info', () => {
    expect(load(['--role=server'])).toMatchObject({ ok: true, config: { logLevel: 'info' } });
  });

  it('reads a level from the environment', () => {
    const result = load(['--role=server'], { AGENTPLEX_LOG_LEVEL: 'debug' });
    expect(result).toMatchObject({ ok: true, config: { logLevel: 'debug' } });
  });

  it('names the accepted levels when given an unknown one', () => {
    const problems = expectProblems(load(['--role=server', '--log-level=loud']));
    expect(problems[0]).toContain('debug, info, warn, error');
  });
});
