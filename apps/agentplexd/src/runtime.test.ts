import { afterEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from './runtime.js';
import { createLogger } from './shared/logger.js';
import type { Config } from './config/config.js';

const dependencies = {
  logger: createLogger('error', () => {}),
  ids: { newId: () => 'hub-under-test' },
  host: '127.0.0.1',
};

const serverOnly: Config = { role: 'server', logLevel: 'error', server: { port: 0 } };
const hubOnly: Config = {
  role: 'hub',
  logLevel: 'error',
  hub: { port: 0, databaseUrl: 'postgres://unused' },
};
const both: Config = {
  role: 'both',
  logLevel: 'error',
  hub: { port: 0, databaseUrl: 'postgres://unused' },
  server: { port: 0 },
};

let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

describe('startRuntime', () => {
  it('starts only the server half for the server role', async () => {
    runtime = await startRuntime(serverOnly, dependencies);

    expect(runtime.hub).toBeNull();
    expect(runtime.server).not.toBeNull();
  });

  it('starts only the hub half for the hub role', async () => {
    runtime = await startRuntime(hubOnly, dependencies);

    expect(runtime.hub).not.toBeNull();
    expect(runtime.server).toBeNull();
  });

  it('starts both halves in one process for the both role', async () => {
    runtime = await startRuntime(both, dependencies);

    expect(runtime.hub).not.toBeNull();
    expect(runtime.server).not.toBeNull();
  });

  it('answers a health check on the port it bound', async () => {
    runtime = await startRuntime(serverOnly, dependencies);
    const port = runtime.server?.port ?? 0;

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    await expect(response.json()).resolves.toMatchObject({ status: 'ok', role: 'server' });
  });

  it('is safe to stop twice, because a signal can arrive twice', async () => {
    runtime = await startRuntime(serverOnly, dependencies);

    await runtime.stop();

    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('leaves no listener behind when a half fails to start', async () => {
    const held = await startRuntime(serverOnly, dependencies);
    const taken: Config = {
      role: 'both',
      logLevel: 'error',
      hub: { port: 0, databaseUrl: 'postgres://unused' },
      server: { port: held.server?.port ?? 0 },
    };

    await expect(startRuntime(taken, dependencies)).rejects.toThrow();

    // The hub half bound a port before the server half failed; if shutdown had
    // not closed it, this second start would fail on the hub port instead.
    await expect(
      startRuntime(serverOnly, dependencies).then((next) => next.stop()),
    ).resolves.toBeUndefined();
    await held.stop();
  });
});
